// Script to import SQLite tables into MongoDB
const sqlite3 = require('sqlite3').verbose();
const mongoose = require('./db');
const Order = require('./models/Order');
const MenuHistory = require('./models/MenuHistory');
const DeductionLog = require('./models/DeductionLog');

const dbFile = './canteen.db';

async function importTable(table, Model, transform = d => d) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.all(`SELECT * FROM ${table}`, async (err, rows) => {
      if (err) return reject(err);
      try {
        await Model.insertMany(rows.map(transform));
        console.log(`Imported ${rows.length} records from ${table}`);
        db.close();
        resolve();
      } catch (e) {
        db.close();
        reject(e);
      }
    });
  });
}

async function main() {
  // Orders
  await importTable('orders', Order, row => ({
    ...row,
    items: JSON.parse(row.items || '[]')
  }));
  // Menu History
  await importTable('menu_history', MenuHistory, row => ({
    ...row,
    items: JSON.parse(row.items || '[]')
  }));
  // Deductions Log
  await importTable('deductions_log', DeductionLog);
  mongoose.connection.close();
}

main().catch(e => { console.error(e); mongoose.connection.close(); });
