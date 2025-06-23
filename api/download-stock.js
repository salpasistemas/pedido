export default async function handler(req, res) {
  let xmlrpc;
  try {
    xmlrpc = require('xmlrpc');
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Could not load xmlrpc module',
      details: err.message
    });
  }

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
    const { location_id = 8, pricelist_id = 5 } = req.body || {};
    const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;
    const missing = ['ODOO_URL','ODOO_DB','ODOO_USERNAME','ODOO_PASSWORD'].filter(v => !process.env[v]);
    if (missing.length) {
      return res.status(500).json({
        success: false,
        error: `Missing environment variables: ${missing.join(', ')}`
      });
    }

    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
    const uid = await new Promise((resolve, reject) => {
      common.methodCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}],
        (err, userId) => err ? reject(err) : resolve(userId));
    });

    if (!uid) {
      return res.status(401).json({ success: false, error: 'Authentication failed' });
    }

    const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });

    const quantIds = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_PASSWORD,
        'stock.quant', 'search',
        [[
          ['location_id', '=', parseInt(location_id)],
          ['quantity', '>', 0],
          ['product_id.active', '=', true]
        ]]
      ], (err, ids) => err ? reject(err) : resolve(ids));
    });

    if (quantIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: `No stock found in location ${location_id}`
      });
    }

    const quants = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_PASSWORD,
        'stock.quant', 'read',
        [quantIds, ['product_id', 'quantity', 'reserved_quantity']]
      ], (err, data) => err ? reject(err) : resolve(data));
    });

    const productQuantities = {};
    quants.forEach(quant => {
      const productId = quant.product_id[0];
      const availableQty = quant.quantity - (quant.reserved_quantity || 0);
      if (availableQty > 0) {
        productQuantities[productId] = (productQuantities[productId] || 0) + availableQty;
      }
    });

    const allProductIds = Object.keys(productQuantities).map(id => parseInt(id));

    const filteredProductIds = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_PASSWORD,
        'product.product', 'search',
        [[
          ['id', 'in', allProductIds],
          ['categ_id', 'child_of', 88]
        ]]
      ], (err, ids) => err ? reject(err) : resolve(ids));
    });

    if (filteredProductIds.length === 0) {
      return res.status(200).json({
        success: true,
        products: [],
        message: 'No products matching category filter'
      });
    }

    const products = await new Promise((resolve, reject) => {
      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_PASSWORD,
        'product.product', 'read',
        [filteredProductIds, ['display_name', 'default_code', 'list_price']]
      ], (err, data) => err ? reject(err) : resolve(data));
    });

    const productPrices = {};
    for (const product of products) {
      try {
        const price = await new Promise((resolve, reject) => {
          models.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD,
            'product.pricelist', 'get_product_price',
            [parseInt(pricelist_id), product.id, 1]
          ], (err, result) => err ? reject(err) : resolve(result));
        });
        productPrices[product.id] = price || product.list_price || 0;
      } catch (err) {
        productPrices[product.id] = product.list_price || 0;
      }
    }

    const finalProducts = products.map(product => ({
      product_id: product.id,
      name: product.display_name,
      default_code: product.default_code || '',
      qty_available: productQuantities[product.id] || 0,
      price: productPrices[product.id] || 0
    }));

    return res.status(200).json({
      success: true,
      products: finalProducts,
      total_products: finalProducts.length
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack
    });
  }
}
