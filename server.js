const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcryptjs = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const upload = multer({ dest: 'uploads/' });
const DATA_FILE = './data.json';
const USERS_FILE = './users.json';
const MENU_HISTORY_FILE = './menu-history.json';
const MENU_PAGE_SETTINGS_FILE = './menu-page-settings.json';
const realtimeClients = new Set();
const isProduction = process.env.NODE_ENV === 'production';

const cron = require("node-cron");

function broadcastRealtimeEvent(type, payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify({
        type,
        ...payload,
        timestamp: new Date().toISOString()
    })}\n\n`;

    realtimeClients.forEach((client) => {
        try {
            client.write(message);
        } catch (err) {
            realtimeClients.delete(client);
        }
    });
}


// --- USER AUTHENTICATION ---
const loadUsers = () => {
    if (fs.existsSync(USERS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(USERS_FILE));
        } catch (e) {
            return [];
        }
    }
    return [];
};

const saveUsers = (users) => {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

let users = loadUsers();

// --- DATABASE LOGIC ---
const loadData = () => {
    if (fs.existsSync(DATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DATA_FILE));
        } catch (e) {
            return [];
        }
    }
    return [];
};

const saveData = (data) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

const getDefaultMenuPageSettings = () => ({
    isOpen: true,
    contactInfo: ''
});

const loadMenuPageSettings = () => {
    if (fs.existsSync(MENU_PAGE_SETTINGS_FILE)) {
        try {
            const savedSettings = JSON.parse(fs.readFileSync(MENU_PAGE_SETTINGS_FILE));
            return {
                ...getDefaultMenuPageSettings(),
                ...savedSettings
            };
        } catch (e) {
            return getDefaultMenuPageSettings();
        }
    }

    return getDefaultMenuPageSettings();
};

const saveMenuPageSettings = (settings) => {
    fs.writeFileSync(MENU_PAGE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
};

const getSnapshotDateKey = () => {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
};

const snapshotMenuForDate = (targetDate = getSnapshotDateKey()) => {
    const activeItems = db
        .filter(item => item.status === 'active')
        .map(item => ({
            id: item.id,
            name: item.name,
            price: item.price,
            url: item.url
        }));
    const activeItemMap = new Map(activeItems.map(item => [item.id, item]));

    dbSqlite.get(
        "SELECT items FROM menu_history WHERE date = ?",
        [targetDate],
        (readErr, existingRow) => {
            if (readErr) {
                console.error("Error reading existing menu history snapshot:", readErr);
                return;
            }

            let existingItems = [];
            if (existingRow?.items) {
                try {
                    existingItems = JSON.parse(existingRow.items) || [];
                } catch (parseErr) {
                    console.error("Error parsing existing menu history snapshot:", parseErr);
                }
            }

            // Keep items that were already posted earlier today, and refresh details
            // for any item that is currently active.
            const mergedItems = existingItems.map(item => activeItemMap.get(item.id) || item);
            const existingIds = new Set(existingItems.map(item => item.id));

            activeItems.forEach(item => {
                if (!existingIds.has(item.id)) {
                    mergedItems.push(item);
                }
            });

            const snapshot = {
                date: targetDate,
                capturedAt: new Date().toISOString(),
                totalItems: mergedItems.length,
                items: mergedItems
            };

            dbSqlite.run(
                `
                    INSERT INTO menu_history (date, capturedAt, totalItems, items)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(date) DO UPDATE SET
                        capturedAt = excluded.capturedAt,
                        totalItems = excluded.totalItems,
                        items = excluded.items
                `,
                [snapshot.date, snapshot.capturedAt, snapshot.totalItems, JSON.stringify(snapshot.items)],
                (writeErr) => {
                    if (writeErr) {
                        console.error("Error saving menu history snapshot:", writeErr);
                    }
                }
            );
        }
    );

    return {
        date: targetDate,
        capturedAt: new Date().toISOString(),
        totalItems: activeItems.length,
        items: activeItems
    };
};

let db = loadData();

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// --- MIDDLEWARE ---
app.use(express.json());

if (isProduction) {
    app.set('trust proxy', 1);
}

// Configure secure session management
app.use(session({
    store: new SQLiteStore({ db: './sessions.db' }),
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,        // Prevents JavaScript from accessing the cookie
        secure: isProduction,  // HTTPS-only cookies in production
        sameSite: isProduction ? 'lax' : 'strict',
        maxAge: 24 * 60 * 60 * 1000  // 24 hours
    }
}));

// 1. Redirect the root URL to the login page
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// 2. Serve static files, but disable the automatic 'index.html' loading
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/realtime-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    realtimeClients.add(res);

    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        realtimeClients.delete(res);
    });
});


// --- AUTHENTICATION MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    if (req.session && req.session.userId) {
        // Find user and populate req.user object
        const user = users.find(u => u.id === req.session.userId);
        if (user) {
            req.user = {
                id: user.id,
                email: user.email,
                role: user.role
            };
            return next();
        }
    }
    res.status(401).json({ message: 'Unauthorized. Please login.' });
};

// Role-based middleware
const roleMiddleware = (requiredRoles) => {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ message: 'Unauthorized. Please login.' });
        }
        const user = users.find(u => u.id === req.session.userId);
        if (!user || !requiredRoles.includes(user.role)) {
            return res.status(403).json({ message: 'Forbidden. Insufficient permissions.' });
        }
        req.user = user;
        next();
    };
};

// --- ROUTES ---

// --- AUTHENTICATION API ---

// Check if user is authenticated
app.get('/api/check-session', (req, res) => {
    if (req.session && req.session.userId) {
        const user = users.find(u => u.id === req.session.userId);
        if (user) {
            res.json({ authenticated: true, role: user.role, email: user.email });
        } else {
            res.json({ authenticated: false });
        }
    } else {
        res.json({ authenticated: false });
    }
});

// Login route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = users.find(u => u.email === email.toLowerCase());
    
    if (!user) {
        // Don't reveal if user exists (security best practice)
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    try {
        const passwordMatch = await bcryptjs.compare(password, user.password);
        
        if (!passwordMatch) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }

        // Login successful - create session
        req.session.userId = user.id;
        req.session.email = user.email;
        
        console.log(`User logged in: ${user.email} (${user.role})`);
        res.json({ success: true, role: user.role, email: user.email });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// Register route (SUPER-ADMIN ONLY)
app.post('/api/register', roleMiddleware(['super-admin']), async (req, res) => {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
        return res.status(400).json({ message: 'Email, password, and role are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    // Check if email already exists
    const existingUser = users.find(u => u.email === email.toLowerCase());
    if (existingUser) {
        return res.status(409).json({ message: 'Email already registered.' });
    }

    // Validate role (super-admin can create any role)
    if (!['super-admin', 'admin', 'pos'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role.' });
    }

    try {
        // Hash password
        const hashedPassword = await bcryptjs.hash(password, 10);

        // Create new user
        const newUser = {
            id: Math.max(...users.map(u => u.id), 0) + 1,
            email: email.toLowerCase(),
            password: hashedPassword,
            role: role,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        console.log(`New user registered: ${newUser.email} (${newUser.role}) by ${req.user.email}`);
        res.status(201).json({ 
            success: true, 
            message: 'User registered successfully.',
            user: {
                id: newUser.id,
                email: newUser.email,
                role: newUser.role
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

// Logout route
app.post('/api/logout', (req, res) => {
    if (req.session && req.session.userId) {
        const userEmail = req.session.email;
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ message: 'Logout failed.' });
            }
            console.log(`User logged out: ${userEmail}`);
            res.json({ success: true, message: 'Logged out successfully.' });
        });
    } else {
        res.json({ success: true, message: 'Not logged in.' });
    }
});

// --- USER MANAGEMENT ROUTES (SUPER-ADMIN ONLY) ---

// Get all users (Super-Admin only)
app.get('/api/users', roleMiddleware(['super-admin']), (req, res) => {
    try {
        const usersList = users.map(u => ({
            id: u.id,
            email: u.email,
            role: u.role,
            createdAt: u.createdAt
        }));
        res.json({ success: true, users: usersList });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error fetching users.' });
    }
});

// Get single user by ID (Super-Admin only)
app.get('/api/users/:id', roleMiddleware(['super-admin']), (req, res) => {
    try {
        const user = users.find(u => u.id === parseInt(req.params.id));
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json({ 
            success: true, 
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ message: 'Server error fetching user.' });
    }
});

// Update user role (Super-Admin only)
app.put('/api/users/:id', roleMiddleware(['super-admin']), (req, res) => {
    try {
        const { role } = req.body;
        const userId = parseInt(req.params.id);

        // Prevent super-admin from changing their own role
        if (userId === req.user.id) {
            return res.status(400).json({ message: 'Cannot change your own role.' });
        }

        if (!['admin', 'pos'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role. Must be "admin" or "pos".' });
        }

        const userIndex = users.findIndex(u => u.id === userId);
        if (userIndex === -1) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const oldRole = users[userIndex].role;
        users[userIndex].role = role;
        saveUsers(users);

        console.log(`User role updated: ${users[userIndex].email} (${oldRole} → ${role}) by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `User role updated from ${oldRole} to ${role}.`,
            user: {
                id: users[userIndex].id,
                email: users[userIndex].email,
                role: users[userIndex].role
            }
        });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ message: 'Server error updating user.' });
    }
});

// Delete user account (Super-Admin only)
app.delete('/api/users/:id', roleMiddleware(['super-admin']), (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        // Prevent super-admin from deleting themselves
        if (userId === req.user.id) {
            return res.status(400).json({ message: 'Cannot delete your own account.' });
        }

        const userIndex = users.findIndex(u => u.id === userId);
        if (userIndex === -1) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const deletedUser = users[userIndex];
        users.splice(userIndex, 1);
        saveUsers(users);

        console.log(`User deleted: ${deletedUser.email} by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: `User ${deletedUser.email} has been deleted.`
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Server error deleting user.' });
    }
});

// Change password endpoint (authenticated users only)
app.post('/api/change-password', authMiddleware, async (req, res) => {
    try {
        const { userId, newPassword, currentPassword } = req.body;
        
        // Validation
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters long.' });
        }

        const targetUserId = parseInt(userId) || req.user.id;
        const userIndex = users.findIndex(u => u.id === targetUserId);

        if (userIndex === -1) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // If super-admin is changing someone else's password, allow it
        // Otherwise, require current password verification
        if (targetUserId !== req.user.id) {
            if (req.user.role !== 'super-admin') {
                return res.status(403).json({ message: 'You can only change your own password.' });
            }
        } else {
            // User changing their own password - verify current password
            if (!currentPassword) {
                return res.status(400).json({ message: 'Current password is required.' });
            }
            const passwordMatch = await bcryptjs.compare(currentPassword, users[userIndex].password);
            if (!passwordMatch) {
                return res.status(401).json({ message: 'Current password is incorrect.' });
            }
        }

        // Hash and update password
        const hashedPassword = await bcryptjs.hash(newPassword, 10);
        users[userIndex].password = hashedPassword;
        saveUsers(users);

        console.log(`Password changed: ${users[userIndex].email} by ${req.user.email}`);
        res.json({ 
            success: true, 
            message: 'Password updated successfully.'
        });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Server error changing password.' });
    }
});

// --- CATEGORY SAVING LOGIC ---


// Helper to save categories to file
const saveCategories = (data) => {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(data, null, 2));
};

// Route: Get saved category items when page loads
app.get('/get-category/:category', (req, res) => {
    const category = req.params.category;
    const categories = loadCategories();
    res.json(categories[category] || []);
});

// Route: Save category items permanently
app.post('/save-category/:category', (req, res) => {
    const category = req.params.category;
    const items = req.body.items || [];
    
    // Load existing, update the specific category, and save
    const categories = loadCategories();
    categories[category] = items;
    saveCategories(categories);
    
    console.log(`Saved ${items.length} items to ${category.toUpperCase()} category.`);
    res.json({ success: true });
});

// Get category items
app.get('/get-category/:type', (req, res) => {
    const { type } = req.params;
    // Retrieve from wherever you saved them
    // For now, return empty array
    res.json([]);
});

// 1. Admin: Get all items
app.get('/images', roleMiddleware(['admin']), (req, res) => {
    res.json(db);
});

// 2. Customer: Get only "posted" (active) items
app.get('/customer-menu', (req, res) => {
    const activeItems = db.filter(item => item.status === "active");
    res.json(activeItems);
});

app.get('/menu-page-settings', (req, res) => {
    res.json(loadMenuPageSettings());
});

app.put('/menu-page-settings', roleMiddleware(['admin', 'super-admin']), (req, res) => {
    const currentSettings = loadMenuPageSettings();
    const nextSettings = {
        ...currentSettings,
        isOpen: req.body.isOpen !== false,
        contactInfo: typeof req.body.contactInfo === 'string' ? req.body.contactInfo.trim() : ''
    };

    saveMenuPageSettings(nextSettings);
    broadcastRealtimeEvent('MENU_PAGE_SETTINGS_UPDATED', nextSettings);
    res.json({ success: true, settings: nextSettings });
});

app.get('/menu-history', roleMiddleware(['admin']), (req, res) => {
    const { date } = req.query;
    if (!date) {
        return dbSqlite.all(
            "SELECT date, totalItems, capturedAt FROM menu_history ORDER BY date DESC",
            [],
            (err, rows) => {
                if (err) {
                    console.error("Error fetching menu history dates:", err);
                    return res.status(500).json({ message: 'Failed to load menu history.' });
                }

                res.json({ dates: rows || [] });
            }
        );
    }

    dbSqlite.get(
        "SELECT date, capturedAt, totalItems, items FROM menu_history WHERE date = ?",
        [date],
        (err, row) => {
            if (err) {
                console.error("Error fetching menu history snapshot:", err);
                return res.status(500).json({ message: 'Failed to load menu history.' });
            }

            if (!row) {
                return res.status(404).json({ message: 'No menu history found for that date.' });
            }

            let items = [];
            try {
                items = JSON.parse(row.items || '[]');
            } catch (parseError) {
                console.error("Error parsing menu history items:", parseError);
            }

            res.json({
                date: row.date,
                capturedAt: row.capturedAt,
                totalItems: row.totalItems,
                items
            });
        }
    );
});

// 3. Upload new item (Admin only, defaults to 'hidden')
app.post('/upload', roleMiddleware(['admin']), upload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const newEntry = {
        id: Date.now().toString(),
        url: `/uploads/${req.file.filename}`,
        name: req.body.photoName || "Untitled",
        price: req.body.photoPrice || "0.00",
        status: "hidden" // Admin must click "Post" to show to customers
    };

    db.push(newEntry);
    saveData(db);
    res.status(201).json(newEntry);
});

// 4. Toggle Post Status (Admin only)
app.patch('/toggle-status/:id', roleMiddleware(['admin', 'pos']), (req, res) => {
    const { id } = req.params;
    const item = db.find(i => i.id === id);
    if (item) {
        item.status = item.status === "active" ? "hidden" : "active";
        saveData(db);
        snapshotMenuForDate();
        return res.json({ success: true, status: item.status });
    }
    res.status(404).json({ message: "Item not found" });
});

// 5. Edit Name and Price (Admin only)
app.put('/edit/:id', roleMiddleware(['admin']), (req, res) => {
    const { id } = req.params;
    const { name, price } = req.body;
    const itemIndex = db.findIndex(item => item.id === id);
    
    if (itemIndex > -1) {
        db[itemIndex].name = name;
        db[itemIndex].price = price;
        saveData(db);
        if (db[itemIndex].status === 'active') {
            snapshotMenuForDate();
        }
        return res.json({ success: true });
    }
    res.status(404).json({ message: "Item not found" });
});

// 6. Delete Item and File (Admin only)
app.delete('/delete/:id', roleMiddleware(['admin']), (req, res) => {
    const { id } = req.params;
    const itemIndex = db.findIndex(item => item.id === id);
    
    if (itemIndex > -1) {
        const item = db[itemIndex];
        const filePath = path.join(__dirname, item.url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        db.splice(itemIndex, 1);
        saveData(db);
        if (item.status === 'active') {
            snapshotMenuForDate();
        }
        return res.json({ success: true });
    }
    res.status(404).json({ message: "Item not found" });
});

// --- CATEGORY SAVING LOGIC ---
const CATEGORIES_FILE = './categories.json';

// Helper to load categories
const loadCategories = () => {
    if (fs.existsSync(CATEGORIES_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CATEGORIES_FILE));
        } catch (e) {
            return { snacks: [], drinks: [] };
        }
    }
    return { snacks: [], drinks: [] };
};



// Route: Save category items permanently (Admin only)
app.post('/save-category/:category', roleMiddleware(['admin']), (req, res) => {
    const category = req.params.category;
    const items = req.body.items || [];
    
    // Load existing, update the specific category, and save
    const categories = loadCategories();
    categories[category] = items;
    saveCategories(categories);
    
    console.log(`Saved ${items.length} items to ${category.toUpperCase()} category.`);
    res.json({ success: true });
});





// Helper to load/save orders
const loadOrders = () => {
    if (fs.existsSync(ORDERS_FILE)) {
        return JSON.parse(fs.readFileSync(ORDERS_FILE));
    }
    return [];
};






/// New Route: Place Order (POS & Admin only, With SQLite Inventory Deduction)
app.post('/place-order', roleMiddleware(['admin', 'pos']), (req, res) => {
    const newOrder = { id: Date.now().toString(), ...req.body };
    
    // 1. Save the order to SQLite instead of JSON
    const stmt = dbSqlite.prepare(`
        INSERT INTO orders (id, customer, items, total, status, date, time, unreturnedChangeAmount) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Convert the items array to a string so SQLite can store it easily
    const itemsString = JSON.stringify(newOrder.items || []);

    stmt.run([
        newOrder.id, 
        newOrder.customer || "Guest", 
        itemsString, 
        newOrder.total, 
        newOrder.status || "Unpaid", 
        newOrder.date, 
        newOrder.time,
        newOrder.unreturnedChangeAmount || null
    ], function(err) {
        if (err) {
            console.error("Failed to save order to DB:", err);
            // Even if DB fails, we probably shouldn't crash the POS, but log it
        } else {
            console.log(`\n================================`);
            console.log(`Saved POS Order to SQLite: ₱${newOrder.total}`);
        }
    });
    stmt.finalize();

    // 2. Deduct from SQLite Inventory & categories.json
    if (newOrder.items && Array.isArray(newOrder.items)) {
        const categoriesFile = './categories.json';
        let categories = fs.existsSync(categoriesFile) ? JSON.parse(fs.readFileSync(categoriesFile)) : {};
        let categoriesChanged = false;

        newOrder.items.forEach(cartItem => {
            const boughtQty = Number(cartItem.qty || cartItem.quantity || 1);
            console.log(`-> Deducting ${boughtQty}x of "${cartItem.name}" (ID: ${cartItem.id})`);

            let isSnackOrDrink = false; // NEW FLAG TO TRACK IF IT IS A SNACK/DRINK

            // A. Update the POS Menu (categories.json)
            ['snacks', 'drinks'].forEach(cat => {
                if (categories[cat]) {
                    const catItemIndex = categories[cat].findIndex(i => String(i.id) === String(cartItem.id));
                    if (catItemIndex !== -1) {
                        isSnackOrDrink = true; // WE FOUND IT! IT IS A SNACK OR DRINK
                        const catItem = categories[cat][catItemIndex];
                        if (catItem && catItem.stockDisplay) {
                            const stockMatch = String(catItem.stockDisplay).match(/^([\d.]+)/);
                            if (stockMatch) {
                                const currentStock = parseFloat(stockMatch[1]);
                                const newStock = Math.max(0, currentStock - boughtQty);
                                catItem.stockDisplay = catItem.stockDisplay.replace(stockMatch[1], newStock);
                                categoriesChanged = true;
                                console.log(`   Updated ${cat} category: ${catItem.name} new stock: ${catItem.stockDisplay}`);
                            }
                        }
                    }
                }
            });

            // B. Update the Admin Inventory (SQLite Database) - FIFO LOGIC
            dbSqlite.all(
                "SELECT * FROM inventory WHERE name = ? ORDER BY id ASC",
                [cartItem.name], 
                (err, rows) => {
                    if (err) {
                        console.error("SQLite query error:", err);
                        return;
                    }
                    
                    if (rows && rows.length > 0) {
                        console.log(`   🔍 Found ${rows.length} batches in SQLite inventory for: ${cartItem.name}`);
                        
                        let remainingToDeduct = boughtQty;

                        // Recursive function to process FIFO batches sequentially
                        const processBatch = (index) => {
                            if (index >= rows.length || remainingToDeduct <= 0) return;
                            
                            let row = rows[index];
                            if (row.stockDisplay) {
                                const stockMatch = String(row.stockDisplay).match(/^([\d.]+)/);
                                if (stockMatch) {
                                    const currentStock = parseFloat(stockMatch[1]);
                                    
                                    if (currentStock > 0) {
                                        let deduction = Math.min(currentStock, remainingToDeduct);
                                        let newStock = currentStock - deduction;
                                        remainingToDeduct -= deduction; 
                                        
                                        const nextActiveDisplay = String(row.stockDisplay).replace(stockMatch[1], newStock);
                                        const promotedState = promotePendingRestockBatch(row, nextActiveDisplay);

                                        dbSqlite.run(
                                            "UPDATE inventory SET stockDisplay = ?, restockAddedStock = ?, pendingRestockDate = ?, dateAdded = ? WHERE id = ?",
                                            [promotedState.stockDisplay, promotedState.restockAddedStock, promotedState.pendingRestockDate, promotedState.dateAdded, row.id],
                                            (updateErr) => {
                                                if (updateErr) console.error("SQLite update error:", updateErr);
                                                else {
                                                    console.log(`   FIFO: Inventory Updated! ${row.name} (Batch ${row.id}) new stock: ${promotedState.stockDisplay}`);
                                                    broadcastRealtimeEvent('inventory-updated', {
                                                        id: row.id,
                                                        action: 'pos-sale',
                                                        name: row.name
                                                    });
                                                }
                                                
                                                processBatch(index + 1);
                                            }
                                        );
                                        return; 
                                    }
                                }
                            }
                            processBatch(index + 1);
                        };
                        
                        processBatch(0);

                    } else {
                        console.log(`   Item "${cartItem.name}" not found in SQLite inventory`);
                    }
                }
            );

            // C. ONLY LOG SNACKS AND DRINKS (Uses our flag to perfectly ignore meals)
            if (isSnackOrDrink) {
                // Look up the cost price from the admin inventory
                dbSqlite.get("SELECT unitPriceDisplay FROM inventory WHERE name = ? ORDER BY id ASC LIMIT 1", [cartItem.name], (err, row) => {
                    const unitCost = row ? row.unitPriceDisplay : 'N/A';
                    
                    dbSqlite.run(
                        `INSERT INTO deductions_log (name, qty, type, date, unitPrice) VALUES (?, ?, ?, ?, ?)`,
                        [cartItem.name, boughtQty, 'POS Sale', new Date().toLocaleDateString(), unitCost],
                        (insertErr) => {
                            if (insertErr) {
                                console.error("Error logging POS deduction:", insertErr);
                                return;
                            }

                            broadcastRealtimeEvent('deductions-updated', {
                                action: 'pos-sale',
                                name: cartItem.name
                            });
                        }
                    );
                });
            }

        });

        // Save the categories.json file so POS menu updates instantly
        if (categoriesChanged) {
            fs.writeFileSync(categoriesFile, JSON.stringify(categories, null, 2));
            console.log(`   POS Menu (categories.json) Updated!`);
        }
    }

    console.log(`================================\n`);
    res.status(201).json({ success: true });
});

// New Route: Get History (For your Admin History tab)
// Route: Get History (Reads from SQLite)
app.get('/order-history', (req, res) => {
    dbSqlite.all("SELECT * FROM orders ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            console.error("Error fetching orders:", err);
            return res.status(500).json({ error: err.message });
        }
        
        // Convert the stringified items back into arrays for the frontend
        const formattedOrders = rows.map(row => ({
            ...row,
            items: JSON.parse(row.items)
        }));
        
        res.json(formattedOrders);
    });
});

// Route: Update Order Status (Updates SQLite)
app.patch('/update-order-status/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    dbSqlite.run(
        "UPDATE orders SET status = ? WHERE id = ?",
        [status, id],
        function(err) {
            if (err) {
                console.error("Error updating order:", err);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: "Order not found" });
            }
            
            console.log(`Order ${id} updated to ${status} in SQLite`);
            res.status(200).json({ success: true });
        }
    );
});

// Route: Update Unreturned Change Amount
app.patch('/update-unreturned-change/:id', (req, res) => {
    const { id } = req.params;
    const { unreturnedChangeAmount } = req.body;

    dbSqlite.run(
        "UPDATE orders SET unreturnedChangeAmount = ? WHERE id = ?",
        [unreturnedChangeAmount, id],
        function(err) {
            if (err) {
                console.error("Error updating unreturned change:", err);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: "Order not found" });
            }
            
            console.log(`Order ${id} unreturned change updated to ₱${unreturnedChangeAmount} in SQLite`);
            res.status(200).json({ success: true });
        }
    );
});

// --- SCHEDULED TASKS ---
// Automatically unpost (hide) all menu items at 11:59 PM every day
cron.schedule('23 8 * * *', () => {
    let itemsUpdated = false;

    // Loop through all items in the database
    db.forEach(item => {
        if (item.status === "active") {
            item.status = "hidden";
            itemsUpdated = true;
        }
    });

    // If any items were changed, save the updated database
    if (itemsUpdated) {
        saveData(db);
        console.log(`[${new Date().toLocaleTimeString()}] Nightly Reset: All menu items have been automatically unposted.`);
    }
});

const sqlite3 = require('sqlite3').verbose();

// Initialize SQLite Database
const dbSqlite = new sqlite3.Database('./canteen.db', (err) => {
    if (err) console.error("Database opening error: ", err);
});

const normalizeInventoryCategory = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'snack' || normalized === 'drinks') return normalized === 'drinks' ? 'drink' : 'snack';
    if (normalized === 'drink' || normalized === 'ingredient') return normalized;
    if (normalized === 'ingredients') return 'ingredient';
    return 'ingredient';
};

// Create Inventory Table if it doesn't exist
dbSqlite.serialize(() => {
    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cost REAL NOT NULL,
            stockDisplay TEXT NOT NULL,
            unitPriceDisplay TEXT NOT NULL,
            dateAdded TEXT NOT NULL,
            inventoryCategory TEXT DEFAULT 'ingredient',
            lowStockThreshold REAL DEFAULT 0,
            expiryDate TEXT,
            restockPreviousStock TEXT,
            restockAddedStock TEXT,
            pendingRestockDate TEXT
        )
    `);
    
    // Safely add the columns to your existing SQLite database
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN inventoryCategory TEXT DEFAULT 'ingredient'`, (err) => {});
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN lowStockThreshold REAL DEFAULT 0`, (err) => {});
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN expiryDate TEXT`, (err) => {});
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN restockPreviousStock TEXT`, (err) => {});
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN restockAddedStock TEXT`, (err) => {});
    dbSqlite.run(`ALTER TABLE inventory ADD COLUMN pendingRestockDate TEXT`, (err) => {});

    dbSqlite.run(
        `UPDATE inventory SET inventoryCategory = 'ingredient' WHERE inventoryCategory IS NULL OR TRIM(inventoryCategory) = ''`,
        (err) => {}
    );


    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            customer TEXT,
            items TEXT,
            total REAL,
            status TEXT,
            date TEXT,
            time TEXT,
            unreturnedChangeAmount REAL
        )
    `);

    // Safely add unreturnedChangeAmount column to existing database
    dbSqlite.run(`ALTER TABLE orders ADD COLUMN unreturnedChangeAmount REAL`, (err) => {});

    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS menu_history (
            date TEXT PRIMARY KEY,
            capturedAt TEXT NOT NULL,
            totalItems INTEGER NOT NULL DEFAULT 0,
            items TEXT NOT NULL
        )
    `);

    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS deductions_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            qty REAL NOT NULL,
            type TEXT NOT NULL,
            date TEXT NOT NULL,
            unitPrice TEXT DEFAULT 'N/A'
        )
    `);
    // Safely add the column to existing database
    dbSqlite.run(`ALTER TABLE deductions_log ADD COLUMN unitPrice TEXT DEFAULT 'N/A'`, (err) => {});

    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS inventory_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventoryItemId INTEGER,
            itemName TEXT NOT NULL,
            actionType TEXT NOT NULL,
            quantity TEXT NOT NULL,
            unitPriceDisplay TEXT,
            totalCost REAL DEFAULT 0,
            dateLogged TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create sold_outs table for tracking when items are marked as sold out
    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS sold_outs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            itemId TEXT NOT NULL,
            itemName TEXT NOT NULL,
            mealType TEXT,
            soldOutTime TEXT NOT NULL,
            date TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create other_expenses table for tracking monthly other expenses
    dbSqlite.run(`
        CREATE TABLE IF NOT EXISTS other_expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            amount REAL NOT NULL,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    dbSqlite.get("SELECT COUNT(*) AS count FROM menu_history", [], (countErr, row) => {
        if (countErr) {
            console.error("Error checking menu_history table:", countErr);
            return;
        }

        if ((row?.count || 0) > 0 || !fs.existsSync(MENU_HISTORY_FILE)) {
            return;
        }

        try {
            const existingHistory = JSON.parse(fs.readFileSync(MENU_HISTORY_FILE));
            const entries = Object.values(existingHistory || {});

            entries.forEach((entry) => {
                dbSqlite.run(
                    `
                        INSERT OR REPLACE INTO menu_history (date, capturedAt, totalItems, items)
                        VALUES (?, ?, ?, ?)
                    `,
                    [
                        entry.date,
                        entry.capturedAt || new Date().toISOString(),
                        entry.totalItems || (entry.items || []).length,
                        JSON.stringify(entry.items || [])
                    ],
                    (insertErr) => {
                        if (insertErr) {
                            console.error("Error migrating menu history to SQLite:", insertErr);
                        }
                    }
                );
            });

            if (entries.length > 0) {
                console.log(`Migrated ${entries.length} menu history snapshot(s) into SQLite.`);
            }
        } catch (migrationErr) {
            console.error("Failed to migrate menu history JSON into SQLite:", migrationErr);
        }
    });

    // --- DEDUCTION LOGS ---
app.post('/log-deduction', (req, res) => {
    // Add unitPrice to the destructuring
    const { name, qty, type, date, unitPrice } = req.body; 
    
    dbSqlite.run(
        `INSERT INTO deductions_log (name, qty, type, date, unitPrice) VALUES (?, ?, ?, ?, ?)`,
        [name, qty, type, date, unitPrice || 'N/A'], // Save the unit price
        (err) => {
            if (err) console.error("Error logging deduction:", err);
            else broadcastRealtimeEvent('deductions-updated', { action: 'created', name });
            res.json({ success: true });
        }
    );
});

app.get('/today-deductions', (req, res) => {
    dbSqlite.all("SELECT * FROM deductions_log", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- SOLD OUT TRACKING ROUTES ---
app.post('/log-soldout', (req, res) => {
    const { itemId, itemName, mealType } = req.body;
    
    if (!itemId || !itemName) {
        return res.status(400).json({ error: 'Missing itemId or itemName' });
    }

    const now = new Date();
    const soldOutTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const date = now.toLocaleDateString('en-US');

    dbSqlite.run(
        `INSERT INTO sold_outs (itemId, itemName, mealType, soldOutTime, date) VALUES (?, ?, ?, ?, ?)`,
        [itemId, itemName, mealType || 'Meal', soldOutTime, date],
        function(err) {
            if (err) {
                console.error("Error logging sold out:", err);
                return res.status(500).json({ error: err.message });
            }
            console.log(`Logged as SOLD OUT: ${itemName} at ${soldOutTime}`);
            res.json({ success: true, soldOutTime, date });
        }
    );
});

app.get('/sold-outs-by-date', (req, res) => {
    const { date } = req.query;
    
    if (!date) {
        return res.status(400).json({ error: 'Missing date parameter' });
    }

    dbSqlite.all(
        "SELECT * FROM sold_outs WHERE date = ? ORDER BY soldOutTime DESC",
        [date],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.get('/sold-outs', (req, res) => {
    dbSqlite.all(
        "SELECT * FROM sold_outs ORDER BY date DESC, soldOutTime DESC",
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// --- OTHER EXPENSES ROUTES ---

// Add a new other expense
app.post('/add-other-expense', (req, res) => {
    const { name, amount, year, month } = req.body;
    
    if (!name || !amount || !year || !month) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    dbSqlite.run(
        `INSERT INTO other_expenses (name, amount, year, month) VALUES (?, ?, ?, ?)`,
        [name, amount, year, month],
        function(err) {
            if (err) {
                console.error("Error adding other expense:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Get other expenses for a specific month
app.get('/other-expenses/:year/:month', (req, res) => {
    const { year, month } = req.params;

    dbSqlite.all(
        `SELECT * FROM other_expenses WHERE year = ? AND month = ? ORDER BY createdAt DESC`,
        [year, month],
        (err, rows) => {
            if (err) {
                console.error("Error fetching other expenses:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows || []);
        }
    );
});

// Delete an other expense
app.delete('/delete-other-expense/:id', (req, res) => {
    const { id } = req.params;

    dbSqlite.run(
        `DELETE FROM other_expenses WHERE id = ?`,
        [id],
        function(err) {
            if (err) {
                console.error("Error deleting other expense:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true });
        }
    );
});

// Clear all expenses for a specific month
app.delete('/clear-all-expenses/:year/:month', (req, res) => {
    const { year, month } = req.params;

    dbSqlite.run(
        `DELETE FROM other_expenses WHERE year = ? AND month = ?`,
        [year, month],
        function(err) {
            if (err) {
                console.error("Error clearing expenses:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, deleted: this.changes });
        }
    );
});

});
// --- INVENTORY ROUTES (SQLite) ---

function logInventoryHistoryEntry(entry, callback = () => {}) {
    const {
        inventoryItemId = null,
        itemName,
        actionType,
        quantity,
        unitPriceDisplay = '',
        totalCost = 0,
        dateLogged = new Date().toISOString()
    } = entry || {};

    if (!itemName || !actionType || !quantity) {
        callback();
        return;
    }

    dbSqlite.run(
        `INSERT INTO inventory_history (inventoryItemId, itemName, actionType, quantity, unitPriceDisplay, totalCost, dateLogged)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [inventoryItemId, itemName, actionType, quantity, unitPriceDisplay, totalCost, dateLogged],
        (err) => {
            if (err) {
                console.error("Inventory history log error:", err);
            } else {
                broadcastRealtimeEvent('inventory-history-updated', {
                    inventoryItemId,
                    actionType
                });
            }
            callback();
        }
    );
}

function getStockNumberFromDisplay(stockDisplay) {
    if (!stockDisplay) return 0;
    const match = String(stockDisplay).trim().match(/^([\d.]+)/);
    return match ? parseFloat(match[1]) || 0 : 0;
}

function addInventoryStockDisplays(baseDisplay, addedDisplay) {
    const base = String(baseDisplay || '').trim();
    const added = String(addedDisplay || '').trim();
    if (!base) return added;
    if (!added) return base;

    const bothPattern = /^([\d.]+)\s*([A-Za-z]+)\s*\(([\d.]+)\s*([A-Za-z]+)\)$/;
    const singlePattern = /^([\d.]+)\s*([A-Za-z]+)$/;

    const baseBoth = base.match(bothPattern);
    const addedBoth = added.match(bothPattern);
    if (baseBoth && addedBoth) {
        if (baseBoth[2].toLowerCase() !== addedBoth[2].toLowerCase() || baseBoth[4].toLowerCase() !== addedBoth[4].toLowerCase()) {
            return added;
        }

        const totalPrimary = Number(((parseFloat(baseBoth[1]) || 0) + (parseFloat(addedBoth[1]) || 0)).toFixed(2));
        const totalSecondary = Number(((parseFloat(baseBoth[3]) || 0) + (parseFloat(addedBoth[3]) || 0)).toFixed(2));
        return `${totalPrimary} ${baseBoth[2]} (${totalSecondary} ${baseBoth[4]})`;
    }

    const baseSingle = base.match(singlePattern);
    const addedSingle = added.match(singlePattern);
    if (baseSingle && addedSingle) {
        if (baseSingle[2].toLowerCase() !== addedSingle[2].toLowerCase()) {
            return added;
        }

        const total = Number(((parseFloat(baseSingle[1]) || 0) + (parseFloat(addedSingle[1]) || 0)).toFixed(2));
        return `${total} ${baseSingle[2]}`;
    }

    return added;
}

function promotePendingRestockBatch(row, nextActiveDisplay) {
    const activeDisplay = String(nextActiveDisplay ?? row.stockDisplay ?? '').trim();
    const pendingDisplay = String(row.restockAddedStock || '').trim();
    const activeQty = getStockNumberFromDisplay(activeDisplay);

    if (activeQty <= 0 && pendingDisplay) {
        return {
            stockDisplay: pendingDisplay,
            restockAddedStock: null,
            pendingRestockDate: null,
            dateAdded: row.pendingRestockDate || row.dateAdded || null
        };
    }

    return {
        stockDisplay: activeDisplay,
        restockAddedStock: row.restockAddedStock || null,
        pendingRestockDate: row.pendingRestockDate || null,
        dateAdded: row.dateAdded || null
    };
}

// 1. Get all inventory items
app.get('/inventory', (req, res) => {
    dbSqlite.all("SELECT * FROM inventory ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/inventory-history', (req, res) => {
    dbSqlite.all(
        "SELECT * FROM inventory_history ORDER BY datetime(createdAt) DESC, id DESC",
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

app.delete('/inventory-history/:id', (req, res) => {
    const id = req.params.id;

    dbSqlite.get(
        "SELECT * FROM inventory_history WHERE id = ?",
        [id],
        (readErr, row) => {
            if (readErr) return res.status(500).json({ error: readErr.message });
            if (!row) return res.status(404).json({ error: 'History record not found.' });

            dbSqlite.run(
                "DELETE FROM inventory_history WHERE id = ?",
                [id],
                function(deleteErr) {
                    if (deleteErr) return res.status(500).json({ error: deleteErr.message });

                    broadcastRealtimeEvent('inventory-history-updated', {
                        id,
                        action: 'deleted',
                        actionType: row.actionType
                    });

                    res.json({ success: true, deletedID: id });
                }
            );
        }
    );
});

// 2. Add a new inventory item (Updated to accept thresholds and expiry dates)
app.post('/inventory', (req, res) => {
    const { name, cost, stockDisplay, unitPriceDisplay, dateAdded, inventoryCategory, lowStockThreshold, expiryDate, restockPreviousStock, restockAddedStock, pendingRestockDate, inventoryHistory } = req.body;
    const normalizedCategory = normalizeInventoryCategory(inventoryCategory);
    
    const stmt = dbSqlite.prepare(`
        INSERT INTO inventory (name, cost, stockDisplay, unitPriceDisplay, dateAdded, inventoryCategory, lowStockThreshold, expiryDate, restockPreviousStock, restockAddedStock, pendingRestockDate) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run([
        name, 
        cost, 
        stockDisplay, 
        unitPriceDisplay, 
        dateAdded, 
        normalizedCategory,
        lowStockThreshold || 0, 
        expiryDate || null,
        restockPreviousStock || null,
        restockAddedStock || null,
        pendingRestockDate || null
    ], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        broadcastRealtimeEvent('inventory-updated', { id: this.lastID, action: 'created' });

        logInventoryHistoryEntry({
            inventoryItemId: this.lastID,
            itemName: inventoryHistory?.itemName || name,
            actionType: inventoryHistory?.actionType || 'added',
            quantity: inventoryHistory?.quantity || stockDisplay,
            unitPriceDisplay: inventoryHistory?.unitPriceDisplay || unitPriceDisplay,
            totalCost: inventoryHistory?.totalCost ?? cost,
            dateLogged: inventoryHistory?.dateLogged || new Date().toISOString()
        }, () => {
            res.json({ success: true, id: this.lastID });
        });
    });
    stmt.finalize();
});

// 3. Delete an inventory item
app.delete('/inventory/:id', (req, res) => {
    const id = req.params.id;

    dbSqlite.get("SELECT id, name FROM inventory WHERE id = ?", [id], (readErr, itemRow) => {
        if (readErr) {
            return res.status(500).json({ error: readErr.message });
        }

        if (!itemRow) {
            return res.status(404).json({ error: 'Inventory item not found.' });
        }

        dbSqlite.get(
            "SELECT COUNT(*) AS count FROM deductions_log WHERE name = ?",
            [itemRow.name],
            (deductionErr, deductionRow) => {
                if (deductionErr) {
                    return res.status(500).json({ error: deductionErr.message });
                }

                const hasDeductions = Number(deductionRow?.count || 0) > 0;

                dbSqlite.run("DELETE FROM inventory WHERE id = ?", [id], function(deleteErr) {
                    if (deleteErr) {
                        return res.status(500).json({ error: deleteErr.message });
                    }

                    const finishDelete = (historyDeletedCount = 0) => {
                        broadcastRealtimeEvent('inventory-updated', { id, action: 'deleted' });
                        if (historyDeletedCount > 0) {
                            broadcastRealtimeEvent('inventory-history-updated', {
                                inventoryItemId: Number(id),
                                action: 'deleted-with-item'
                            });
                        }

                        res.json({
                            success: true,
                            deletedID: id,
                            hadDeductions: hasDeductions,
                            deletedHistoryCount: historyDeletedCount
                        });
                    };

                    if (hasDeductions) {
                        finishDelete(0);
                        return;
                    }

                    dbSqlite.run(
                        "DELETE FROM inventory_history WHERE inventoryItemId = ?",
                        [id],
                        function(historyErr) {
                            if (historyErr) {
                                return res.status(500).json({ error: historyErr.message });
                            }

                            finishDelete(this.changes || 0);
                        }
                    );
                });
            }
        );
    });
});



// Route to save selected ingredients to a menu item
app.patch('/update-ingredients/:id', (req, res) => {
    const item = db.find(i => i.id === req.params.id);
    if (item) {
        item.ingredients = req.body.ingredients;
        saveData(db); // Saves to your data.json
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Route to update inventory stock, cost, save warning thresholds, AND expiration dates
app.put('/inventory/:id', (req, res) => {
    const id = req.params.id;
    const { stockDisplay, inventoryCategory, lowStockThreshold, expiryDate, cost, dateAdded, restockPreviousStock, restockAddedStock, pendingRestockDate, inventoryHistory } = req.body;
    const updates = [];
    const values = [];

    if (stockDisplay !== undefined) {
        updates.push("stockDisplay = ?");
        values.push(stockDisplay);
    }
    if (cost !== undefined) {
        updates.push("cost = ?");
        values.push(cost);
    }
    if (dateAdded !== undefined) {
        updates.push("dateAdded = ?");
        values.push(dateAdded);
    }
    if (inventoryCategory !== undefined) {
        updates.push("inventoryCategory = ?");
        values.push(normalizeInventoryCategory(inventoryCategory));
    }
    if (restockPreviousStock !== undefined) {
        updates.push("restockPreviousStock = ?");
        values.push(restockPreviousStock);
    }
    if (restockAddedStock !== undefined) {
        updates.push("restockAddedStock = ?");
        values.push(restockAddedStock);
    }
    if (pendingRestockDate !== undefined) {
        updates.push("pendingRestockDate = ?");
        values.push(pendingRestockDate);
    }
    if (lowStockThreshold !== undefined) {
        updates.push("lowStockThreshold = ?");
        values.push(lowStockThreshold);
    }
    if (expiryDate !== undefined) {
        updates.push("expiryDate = ?");
        values.push(expiryDate);
    }

    const finishResponse = () => {
        if (inventoryHistory) {
            logInventoryHistoryEntry({
                inventoryItemId: Number(id),
                itemName: inventoryHistory.itemName,
                actionType: inventoryHistory.actionType || 'restocked',
                quantity: inventoryHistory.quantity,
                unitPriceDisplay: inventoryHistory.unitPriceDisplay || '',
                totalCost: inventoryHistory.totalCost ?? 0,
                dateLogged: inventoryHistory.dateLogged || new Date().toISOString()
            }, () => {
                res.json({ success: true });
            });
            return;
        }

        res.json({ success: true });
    };

    if (!updates.length) {
        finishResponse();
        return;
    }

    values.push(id);

    dbSqlite.run(
        `UPDATE inventory SET ${updates.join(', ')} WHERE id = ?`,
        values,
        function(err) {
            if (err) {
                console.error("Inventory update error:", err);
                res.status(500).json({ error: err.message });
                return;
            }

            broadcastRealtimeEvent('inventory-updated', { id, action: 'updated' });
            finishResponse();
        }
    );
});

// Example Express route for toggling status
app.patch('/update-post-status/:id', (req, res) => {
    const itemId = req.params.id;
    const { status } = req.body;

    // 1. Find the item in your data array/database
    // 2. Update item.status = status
    // 3. Save the data
    
    // Logic:
    const item = menuData.find(i => i.id == itemId);
    if (item) {
        item.status = status;
        // Save to your JSON file here
        res.sendStatus(200);
    } else {
        res.status(404).send("Item not found");
    }
});

// 7. Toggle entire category (e.g., all Snacks or all Drinks)
app.patch('/toggle-category/:type', (req, res) => {
    // 1. Get the category from the URL
    let typeToToggle = req.params.type.toLowerCase(); 
    
    // 2. PLURAL FIX: If the word ends with 's' (like "snacks"), remove the 's' ("snack")
    if (typeToToggle.endsWith('s')) {
        typeToToggle = typeToToggle.slice(0, -1); 
    }

    // 3. Find all items that match this type (also stripping 's' from database items just in case)
    const targetItems = db.filter(item => {
        let itemType = (item.type || '').toLowerCase();
        if (itemType.endsWith('s')) itemType = itemType.slice(0, -1);
        return itemType === typeToToggle;
    });
    
    if (targetItems.length === 0) {
        return res.status(200).json({ message: "No items to toggle." });
    }

    // 4. Logic: If ANY item is 'hidden', make them ALL 'active'. Otherwise, make ALL 'hidden'.
    const areAnyHidden = targetItems.some(item => item.status === 'hidden');
    const newStatus = areAnyHidden ? 'active' : 'hidden';

    // 5. Apply the new status to the database
    db.forEach(item => {
        let itemType = (item.type || '').toLowerCase();
        if (itemType.endsWith('s')) itemType = itemType.slice(0, -1);
        
        if (itemType === typeToToggle) {
            item.status = newStatus;
        }
    });

    saveData(db); // Save to data.json
    res.json({ success: true, status: newStatus });
});


// --- START UP (With IP Display) ---
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'localhost';
    const publicUrl = process.env.PUBLIC_URL;

    for (const name in networkInterfaces) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
            }
        }
    }

    console.log(`\n=========================================`);
    console.log(`SSU CANTEEN SYSTEM ACTIVE`);
    console.log(`➜  Local:   http://localhost:${PORT}`);
    console.log(`➜  Network: http://${localIp}:${PORT}`);
    if (publicUrl) {
        console.log(`➜  Public:  ${publicUrl}`);
    }
    console.log(`=========================================\n`);
});
