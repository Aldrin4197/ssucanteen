const mongoose = require('./db');

const menuHistorySchema = new mongoose.Schema({
  date: String,
  capturedAt: String,
  totalItems: Number,
  items: Array
});

const MenuHistory = mongoose.model('MenuHistory', menuHistorySchema);

module.exports = MenuHistory;