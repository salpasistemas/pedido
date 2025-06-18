// api/download-stock.js
export default async function handler(req, res) {
  // Load xmlrpc safely
  let xmlrpc;
  try {
    xmlrpc = require('xmlrpc');
  } catch (err) {
    console.error('Error loading xmlrpc:', err);
    return res.status(500).json({
      success: false,
      error: 'Could not load xmlrpc module',
      details: err.message
    });
  }

  // CORS
  const allowedOrigins = [
    'https://salpasistemas.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    console.log('=== STOCK DOWNLOAD REQUEST START ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    // Get request parameters (location_id and pricelist_id)
    const { location_id = 8, pricelist_id = 5 } = req.body || {};
    console.log('Requested location_id:', location_id);
    console.log('Requested pricelist_id:', pricelist_id);

    // Read environment variables
    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;
    const missing = ['ODOO_URL','ODOO_DB','ODOO_USERNAME','ODOO_PASSWORD'].filter(v => !process.env[v]);
    if (missing.length) {
      return res.status(500).json({
        success: false,
        error: `Missing environment variables: ${missing.join(', ')}`
      });
    }

    console.log('=== ODOO CONNECTION INFO ===');
    console.log('URL:', ODOO_URL);
    console.log('DB:', ODOO_DB);
    console.log('Username:', ODOO_USERNAME);

    // 1) Authentication
    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [
        ODOO_DB,
        ODOO_USERNAME,
        ODOO_PASSWORD,
        {}
      ], (err, userId) => err ? reject(err) : resolve(userId));
    });
    
    if (!uid) {
      return res.status(401).json({
        success: false,
        error: 'Authentication failed - invalid credentials'
      });
    }
    
    console.log('✅ Authenticated UID:', uid);

    // 2) Client for object calls
    const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

    // 3) Get stock data from specific location
    console.log('=== FETCHING STOCK DATA ===');
    console.log('Location ID:', location_id);
    
    // First, get stock quants for the location
    console.log('Fetching stock quants...');
    const quantIds = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        'stock.quant',
        'search',
        [[
          ['location_id', '=', parseInt(location_id)],
          ['quantity', '>', 0], // Only products with stock
          ['product_id.active', '=', true] // Only active products
        ]]
      ], (err, ids) => err ? reject(err) : resolve(ids));
    });
    
    console.log(`Found ${quantIds.length} stock quants in location ${location_id}`);
    
    if (quantIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: `No stock found in location ${location_id}`,
        location_id,
        pricelist_id
      });
    }

    // Get detailed quant information
    console.log('Fetching quant details...');
    const quants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        'stock.quant',
        'read',
        [quantIds, ['product_id', 'quantity', 'reserved_quantity']]
      ], (err, data) => err ? reject(err) : resolve(data));
    });
    
    console.log(`Retrieved details for ${quants.length} quants`);

    // Get unique product IDs and calculate available quantities
    const productQuantities = {};
    quants.forEach(quant => {
      const productId = quant.product_id[0];
      const availableQty = quant.quantity - (quant.reserved_quantity || 0);
      
      if (availableQty > 0) {
        if (!productQuantities[productId]) {
          productQuantities[productId] = 0;
        }
        productQuantities[productId] += availableQty;
      }
    });
    
    const productIds = Object.keys(productQuantities).map(id => parseInt(id));
    console.log(`Found ${productIds.length} products with available stock`);

    if (productIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: `No available stock found in location ${location_id}`,
        location_id,
        pricelist_id
      });
    }

    // 4) Get product information
    console.log('Fetching product information...');
    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        'product.product',
        'read',
        [productIds, [
          'name', 
          'default_code', 
          'description_sale',
          'list_price',
          'active'
        ]]
      ], (err, data) => err ? reject(err) : resolve(data));
    });
    
    console.log(`Retrieved information for ${products.length} products`);

    // 5) Get prices from pricelist
    console.log(`Fetching prices from pricelist ${pricelist_id}...`);
    
    // We'll get the prices using the pricelist
    const productPrices = {};
    
    // Method to get pricelist prices - we'll call it for each product
    for (const product of products) {
      try {
        const priceData = await new Promise((resolve, reject) => {
          models.methodCall('execute_kw', [
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            'product.pricelist',
            'get_product_price',
            [parseInt(pricelist_id), product.id, 1] // pricelist_id, product_id, qty=1
          ], (err, price) => err ? reject(err) : resolve(price));
        });
        
        productPrices[product.id] = priceData || product.list_price || 0;
      } catch (priceError) {
        console.warn(`Could not get pricelist price for product ${product.id}, using list price`);
        productPrices[product.id] = product.list_price || 0;
      }
    }
    
    console.log('Price retrieval completed');

    // 6) Combine all data
    console.log('Combining product data...');
    const finalProducts = products
      .filter(product => productQuantities[product.id] > 0) // Only products with stock
      .map(product => ({
        product_id: product.id,
        name: product.name,
        default_code: product.default_code || '',
        description: product.description_sale || product.name,
        qty_available: productQuantities[product.id],
        list_price: product.list_price || 0,
        price: productPrices[product.id] || product.list_price || 0
      }))
      .sort((a, b) => {
        // Sort by code first, then by name
        if (a.default_code && b.default_code) {
          return a.default_code.localeCompare(b.default_code);
        }
        return a.name.localeCompare(b.name);
      });

    console.log(`Final product list: ${finalProducts.length} products`);
    
    // 7) Response
    return res.status(200).json({
      success: true,
      products: finalProducts,
      total_products: finalProducts.length,
      location_id: parseInt(location_id),
      pricelist_id: parseInt(pricelist_id),
      message: `Found ${finalProducts.length} products with stock in location ${location_id}`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('=== STOCK DOWNLOAD ERROR ===', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack || 'Check server logs'
    });
  }
}
