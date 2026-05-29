const mongoose = require('./db');

const orderSchema = new mongoose.Schema({
  id: String,
  customer: String,
  items: Array,
  total: Number,
  status: String,
  date: String,
  time: String,
  unreturnedChangeAmount: Number
});

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;