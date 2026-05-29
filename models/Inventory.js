const mongoose = require('./db');

const inventorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  cost: Number,
  stockDisplay: String,
  unitPriceDisplay: String,
  dateAdded: String,
  lowStockThreshold: { type: Number, default: 0 },
  expiryDate: String
});

const Inventory = mongoose.model('Inventory', inventorySchema);

module.exports = Inventory;