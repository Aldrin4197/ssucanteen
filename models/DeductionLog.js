const mongoose = require('./db');

const deductionLogSchema = new mongoose.Schema({
  name: String,
  qty: Number,
  type: String,
  date: String,
  unitPrice: { type: String, default: 'N/A' }
});

const DeductionLog = mongoose.model('DeductionLog', deductionLogSchema);

module.exports = DeductionLog;