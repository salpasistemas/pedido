const { google } = require('googleapis');
const xmlrpc = require('xmlrpc');

// --- Helper Functions ---

// Promisify XML-RPC calls
const xmlrpcCall = (client, method, params) => {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
};

// Authenticate with Odoo
async function getOdooUid(url, db, username, password) {
  const common = xmlrpc.createSecureClient({ url: `${url}/xmlrpc/2/common` });
  return await xmlrpcCall(common, 'authenticate', [db, username, password, {}]);
}

// Fetch stock data from Odoo with category filtering
async function getOdooStock(config, uid, category) {
  const { db, password, location_id, pricelist_id } = config;
  const models = xmlrpc.createSecureClient({ url: `${config.url}/xmlrpc/2/object` });

  const quantIds = await xmlrpcCall(models, 'execute_kw', [
    db, uid, password, 'stock.quant', 'search',
    [[['location_id', '=', location_id], ['quantity', '>', 0], ['product_id.active', '=', true]]]
  ]);

  if (!quantIds.length) return [];

  const quants = await xmlrpcCall(models, 'execute_kw', [
    db, uid, password, 'stock.quant', 'read', [quantIds, ['product_id', 'quantity', 'reserved_quantity']]
  ]);

  const productQuantities = {};
  quants.forEach(q => {
    const availableQty = q.quantity - (q.reserved_quantity || 0);
    if (availableQty > 0) {
      productQuantities[q.product_id[0]] = (productQuantities[q.product_id[0]] || 0) + availableQty;
    }
  });

  const allProductIds = Object.keys(productQuantities).map(id => parseInt(id));
  if (!allProductIds.length) return [];

  let categoryFilter = [];
  if (category === 'general') {
    categoryFilter = ['categ_id', 'child_of', 8];
  } else if (category === 'segunda') {
    categoryFilter = ['categ_id', 'child_of', 88];
  }

  const productSearchDomain = [['id', 'in', allProductIds]];
  if (categoryFilter.length > 0) {
    productSearchDomain.push(categoryFilter);
  }

  const filteredProductIds = await xmlrpcCall(models, 'execute_kw', [
    db, uid, password,
    'product.product', 'search',
    [productSearchDomain]
  ]);

  if (!filteredProductIds.length) return [];

  const products = await xmlrpcCall(models, 'execute_kw', [
    db, uid, password, 'product.product', 'read', 
    [filteredProductIds, ['display_name', 'default_code', 'list_price', 'name']]
  ]);

  const productPrices = {};
  const pricePromises = products.map(async product => {
    try {
      const priceDict = await xmlrpcCall(models, 'execute_kw', [
        db, uid, password,
        'product.pricelist', 'price_get',
        [[parseInt(pricelist_id)], [product.id], 1]
      ]);

      const priceValue = priceDict?.[product.id];
      if (typeof priceValue === 'number') {
        productPrices[product.id] = priceValue;
      } else {
        throw new Error('Invalid price from price_get');
      }

    } catch (err) {
      console.error(`Error getting price from price_get for product ${product.id}:`, err.message);

      try {
        const pricelistItems = await xmlrpcCall(models, 'execute_kw', [
          db, uid, password,
          'product.pricelist.item', 'search_read',
          [[
            ['pricelist_id', '=', parseInt(pricelist_id)],
            ['product_id', '=', product.id]
          ], ['fixed_price', 'price_discount', 'percent_price']]
        ]);

        if (pricelistItems.length > 0) {
          const item = pricelistItems[0];
          productPrices[product.id] =
            item.fixed_price ||
            (product.list_price * (1 - (item.price_discount || 0) / 100)) ||
            product.list_price || 0;
        } else {
          productPrices[product.id] = product.list_price || 0;
        }

      } catch (fallbackErr) {
        console.error(`Fallback price error for product ${product.id}:`, fallbackErr.message);
        productPrices[product.id] = product.list_price || 0;
      }
    }
  });

  await Promise.all(pricePromises);

  return products.map(p => ({
    product_id: p.id,
    name: p.name.replace(/^\[.*?\]\s*/, '').trim(),
    display_name: p.display_name.replace(/^\[.*?\]\s*/, '').trim(),
    qty_available: Math.floor(productQuantities[p.id] || 0),
    price: Math.round((productPrices[p.id] || p.list_price || 0) * 100) / 100,
  })).filter(p => p.qty_available > 0)
     .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

// --- Google Sheets Functions ---

function getGoogleAuth() {
  const { GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL, GOOGLE_PROJECT_ID } = process.env;
  if (!GOOGLE_PRIVATE_KEY || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PROJECT_ID) {
    throw new Error("Missing Google credentials in environment variables");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CLIENT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      project_id: GOOGLE_PROJECT_ID,
    },
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

async function copyTemplate(drive, templateId, category) {
  const now = new Date();
  const argentinaOffset = -3;
  const argentinaTime = new Date(now.getTime() + (argentinaOffset * 60 * 60 * 1000));
  const timestamp = argentinaTime.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

  let categoryName = '';
  if (category === 'general') {
    categoryName = '_';
  } else if (category === 'segunda') {
    categoryName = '2DA_';
  } else {
    categoryName = 'WH-STOCK_';
  }

  const newFileName = `Pedido_Salpa_${categoryName}${timestamp}`;

  const { data } = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: newFileName },
  });

  await drive.permissions.create({
    fileId: data.id,
    requestBody: { role: 'writer', type: 'anyone' }
  });

  return data.id;
}

async function writeToSheet(sheets, spreadsheetId, data) {
  const values = data.map(p => [
    p.product_id,
    1, // Cliente ID
    p.display_name,
    p.qty_available,
    p.price, // Already discounted in Odoo
    '', // Cantidad
    ''  // Subtotal
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'PEDIDO!A2',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

// --- Main API Handler ---

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;
    const { location_id = 8, pricelist_id = 5, category } = req.body || {};
    const odooConfig = {
      url: ODOO_URL, db: ODOO_DB, username: ODOO_USERNAME, password: ODOO_PASSWORD,
      location_id: parseInt(location_id), pricelist_id: parseInt(pricelist_id)
    };

    const { GOOGLE_SHEET_TEMPLATE_ID } = process.env;
    if (!GOOGLE_SHEET_TEMPLATE_ID) {
      return res.status(500).json({ success: false, error: "Missing GOOGLE_SHEET_TEMPLATE_ID" });
    }

    const uid = await getOdooUid(odooConfig.url, odooConfig.db, odooConfig.username, odooConfig.password);
    if (!uid) {
      return res.status(401).json({ success: false, error: 'Odoo authentication failed' });
    }

    const products = await getOdooStock(odooConfig, uid, category);
    if (!products.length) {
      return res.status(200).json({ 
        success: true, 
        message: `No products with available stock found${category ? ` for category ${category}` : ''}.` 
      });
    }

    const auth = await getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    const newSheetId = await copyTemplate(drive, GOOGLE_SHEET_TEMPLATE_ID, category);
    await writeToSheet(sheets, newSheetId, products);

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${newSheetId}/edit`;
    return res.status(200).json({ success: true, url: sheetUrl });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
}
