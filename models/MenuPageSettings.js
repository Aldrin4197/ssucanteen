const mongoose = require('./db');

const menuPageSettingsSchema = new mongoose.Schema({
  isOpen: { type: Boolean, default: true },
  contactInfo: { type: String, default: '' }
});

const MenuPageSettings = mongoose.model('MenuPageSettings', menuPageSettingsSchema);

module.exports = MenuPageSettings;