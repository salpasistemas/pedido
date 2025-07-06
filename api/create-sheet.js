

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

// Fetch stock data from Odoo
async function getOdooStock(config, uid) {
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

  const productIds = Object.keys(productQuantities).map(id => parseInt(id));
  if (!productIds.length) return [];

  const products = await xmlrpcCall(models, 'execute_kw', [
    db, uid, password, 'product.product', 'read', [productIds, ['display_name', 'default_code', 'list_price', 'name']]
  ]);

  const productPrices = {};
  const pricePromises = products.map(async product => {
      try {
        const priceResult = await xmlrpcCall(models, 'execute_kw', [
          db, uid, password,
          'product.pricelist', 'price_get',
          [parseInt(pricelist_id), product.id, 1]
        ]);
        
        if (!priceResult || typeof priceResult !== 'number') {
          const altPrice = await xmlrpcCall(models, 'execute_kw', [
            db, uid, password,
            'product.pricelist', 'get_product_price',
            [parseInt(pricelist_id), product.id, 1]
          ]);
          productPrices[product.id] = altPrice || product.list_price || 0;
        } else {
          productPrices[product.id] = priceResult;
        }
      } catch (err) {
        console.error(`Error getting price for product ${product.id}:`, err.message);
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
            productPrices[product.id] = item.fixed_price || (product.list_price * (1 - (item.price_discount || 0) / 100)) || product.list_price || 0;
          } else {
            productPrices[product.id] = product.list_price || 0;
          }
        } catch (itemErr) {
          console.error(`Error getting pricelist item for product ${product.id}:`, itemErr.message);
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

// Get authenticated Google API client
function getGoogleAuth() {
  const { GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL, GOOGLE_PROJECT_ID } = process.env;
  if (!GOOGLE_PRIVATE_KEY || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PROJECT_ID) {
    throw new Error("Missing Google credentials in environment variables");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CLIENT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Vercel formatting
      project_id: GOOGLE_PROJECT_ID,
    },
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

// Copy the template sheet
async function copyTemplate(drive, templateId) {
  const newFileName = `Pedido de Stock - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
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

// Write data to the new sheet
async function writeToSheet(sheets, spreadsheetId, data) {
  const values = data.map(p => [
    p.product_id,
    1, // Cliente ID
    p.display_name,
    p.qty_available,
    Math.round(p.price * 0.4 * 100) / 100, // Precio con 60% descuento
    '', // Cantidad
    '' // Subtotal
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'PEDIDO!A2', // Start writing at cell A2 of the 'PEDIDO' sheet
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}




// --- Main API Handler ---

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // --- Odoo Config ---
    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;
    const { location_id = 8, pricelist_id = 5 } = req.body || {};
    const odooConfig = {
        url: ODOO_URL, db: ODOO_DB, username: ODOO_USERNAME, password: ODOO_PASSWORD,
        location_id: parseInt(location_id), pricelist_id: parseInt(pricelist_id)
    };
    
    // --- Google Config ---
    const { GOOGLE_SHEET_TEMPLATE_ID } = process.env;
    if (!GOOGLE_SHEET_TEMPLATE_ID) {
        return res.status(500).json({ success: false, error: "Missing GOOGLE_SHEET_TEMPLATE_ID" });
    }

    // 1. Authenticate with Odoo
    const uid = await getOdooUid(odooConfig.url, odooConfig.db, odooConfig.username, odooConfig.password);
    if (!uid) {
      return res.status(401).json({ success: false, error: 'Odoo authentication failed' });
    }

    // 2. Get Stock from Odoo
    const products = await getOdooStock(odooConfig, uid);
    if (!products.length) {
      return res.status(200).json({ success: true, message: 'No products with available stock found.' });
    }

    // 3. Authenticate with Google
    const auth = await getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    // 4. Copy Template and Write Data
    const newSheetId = await copyTemplate(drive, GOOGLE_SHEET_TEMPLATE_ID);
    await writeToSheet(sheets, newSheetId, products);

    // 5. Return new sheet URL
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
