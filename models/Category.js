const mongoose = require('./db');

const categorySchema = new mongoose.Schema({
  snacks: Array,
  drinks: Array
});

const Category = mongoose.model('Category', categorySchema);

module.exports = Category;