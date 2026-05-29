// Script to import JSON and SQLite data into MongoDB
const fs = require('fs');
const path = require('path');
const mongoose = require('./db');
const User = require('./models/User');
const Inventory = require('./models/Inventory');
const Order = require('./models/Order');
const MenuHistory = require('./models/MenuHistory');
const DeductionLog = require('./models/DeductionLog');
const Category = require('./models/Category');
const MenuPageSettings = require('./models/MenuPageSettings');

async function importJSON(file, Model, transform = d => d) {
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file));
  if (Array.isArray(data)) {
    await Model.insertMany(data.map(transform));
  } else {
    await Model.create(transform(data));
  }
  console.log(`Imported data from ${file}`);
}

async function main() {
  await mongoose.connection.dropDatabase();
  // Import users
  await importJSON(path.join(__dirname, 'users.json'), User);
  // Import inventory
  await importJSON(path.join(__dirname, 'data.json'), Inventory);
  // Import categories
  await importJSON(path.join(__dirname, 'categories.json'), Category, d => ({ snacks: d.snacks, drinks: d.drinks }));
  // Import menu page settings
  await importJSON(path.join(__dirname, 'menu-page-settings.json'), MenuPageSettings);
  // TODO: Import SQLite tables (orders, menu_history, deductions_log) if needed
  console.log('All JSON data imported.');
  mongoose.connection.close();
}

main().catch(e => { console.error(e); mongoose.connection.close(); });
