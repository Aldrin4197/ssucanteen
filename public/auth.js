// Authentication utility functions for client-side

// Get the current page's required roles
function getRequiredRoles() {
    const path = window.location.pathname;

    if (path.includes('super-admin.html')) {
        return ['super-admin'];
    } else if (path.includes('index.html') || path === '/' || path === '') {
        // Check for '/' to prevent cashiers from accessing the default root page
        return ['super-admin', 'admin'];
    } else if (path.includes('pos.html')) {
        return ['pos', 'admin', 'super-admin'];
    }

    return [];
}

// Check if user is logged in and has required role
async function checkAuth(requiredRoles = null) {
    // Use provided roles or auto-detect from page
    if (requiredRoles === null) {
        requiredRoles = getRequiredRoles();
    }
    
    try {
        const response = await fetch('/api/check-session');
        const data = await response.json();
        
        if (!data.authenticated) {
            window.location.href = '/login.html';
            return false;
        }
        
        if (requiredRoles.length > 0 && !requiredRoles.includes(data.role)) {
            alert('You do not have permission to access this page.');
            window.location.href = '/login.html';
            return false;
        }
        
        return data;
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login.html';
        return false;
    }
}

// Logout function
async function logout() {
    try {
        const response = await fetch('/api/logout', {
            method: 'POST'
        });
        
        if (response.ok) {
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// Display user information in the page
function displayUserInfo(userEmail, userRole) {
    const userInfoEl = document.getElementById('user-info');
    if (userInfoEl) {
        // Clear any existing content
        userInfoEl.innerHTML = '';
        
        const isPosPage = window.location.pathname.includes('pos.html');
        
        if (!isPosPage) {
            // For non-POS pages, show email and button with text
            const emailSpan = document.createElement('span');
            emailSpan.id = 'user-email';
            emailSpan.textContent = userEmail;
            userInfoEl.appendChild(emailSpan);
        }
        
        // Add logout button
        const logoutBtn = document.createElement('button');
        logoutBtn.id = 'logout-btn';
        logoutBtn.className = 'logout-button';
        
        if (isPosPage) {
            // For POS page, show only icon
            logoutBtn.innerHTML = '<i data-lucide="log-out" style="width: 20px; height: 20px;"></i>';
            logoutBtn.title = 'Logout';
            logoutBtn.onclick = showLogoutModal;
        } else {
            // For other pages, show text
            logoutBtn.textContent = 'Logout';
            logoutBtn.onclick = logout;
        }
        userInfoEl.appendChild(logoutBtn);
        
        // Reinitialize Lucide icons if in POS mode
        if (isPosPage && window.lucide) {
            setTimeout(() => lucide.createIcons(), 10);
        }
    }
}

// Add default logout button styles
function addLogoutStyles() {
    if (!document.getElementById('logout-styles')) {
        const style = document.createElement('style');
        style.id = 'logout-styles';
        style.textContent = `
            #user-info {
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 13px;
                color: #64748b;
            }
            
            #user-email {
                font-weight: 600;
                color: #334155;
            }
            
            #user-role {
                font-size: 12px;
                color: #999;
                font-weight: 500;
            }
            
            .logout-button {
                padding: 8px 14px;
                background: #ef4444;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .logout-button:hover {
                background: #dc2626;
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
            }
            
            /* Icon button styles for POS */
            .logout-button i {
                display: flex;
                align-items: center;
            }
        `;
        document.head.appendChild(style);
    }
}

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', async () => {
    addLogoutStyles();
    const authData = await checkAuth();
    
    if (authData && authData.email) {
        displayUserInfo(authData.email, authData.role);
    }
});
