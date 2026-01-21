// AWS Cognito authentication configuration
const COGNITO_CONFIG = {
    UserPoolId: 'your-user-pool-id',
    ClientId: 'your-app-client-id',
    Region: 'us-east-1'
};

// AWS Cognito service endpoint
const COGNITO_DOMAIN = `https://cognito-idp.${COGNITO_CONFIG.Region}.amazonaws.com`;

// DOM Elements
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const verificationForm = document.getElementById('verification-form');

let pendingVerificationEmail = null;
let pendingVerificationPassword = null;

// Initialize event listeners when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Form toggle links
    document.getElementById('show-signup').addEventListener('click', (e) => {
        e.preventDefault();
        showSignup();
    });
    
    document.getElementById('show-login').addEventListener('click', (e) => {
        e.preventDefault();
        showLogin();
    });
    
    document.getElementById('back-to-login').addEventListener('click', (e) => {
        e.preventDefault();
        showLogin();
    });
    
    // Form submissions
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('signupForm').addEventListener('submit', handleSignup);
    document.getElementById('verificationForm').addEventListener('submit', handleVerification);
    document.getElementById('resend-code').addEventListener('click', handleResendCode);
});

// UI Functions
function showLogin() {
    loginForm.style.display = 'block';
    signupForm.style.display = 'none';
    verificationForm.style.display = 'none';
    clearMessages();
    clearFormFields();
    clearVerificationTimeout();
}

function showSignup() {
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
    verificationForm.style.display = 'none';
    clearMessages();
    clearFormFields();
    clearVerificationTimeout();
}

function showVerification(email) {
    loginForm.style.display = 'none';
    signupForm.style.display = 'none';
    verificationForm.style.display = 'block';
    document.getElementById('verification-email').textContent = email;
    clearMessages();
    startVerificationTimeout();
}

function clearMessages() {
    document.querySelectorAll('.error-message, .success-message').forEach(el => {
        el.classList.remove('show');
        el.textContent = '';
    });
}

function clearFormFields() {
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-firstname').value = '';
    document.getElementById('signup-lastname').value = '';
    document.getElementById('verification-code').value = '';
}

let verificationTimeout = null;

function startVerificationTimeout() {
    clearVerificationTimeout();
    verificationTimeout = setTimeout(() => {
        showLogin();
        showError('login', 'Verification session expired. Please login to resend code.');
    }, 15 * 60 * 1000); // 15 minutes
}

function clearVerificationTimeout() {
    if (verificationTimeout) {
        clearTimeout(verificationTimeout);
        verificationTimeout = null;
    }
}

function showError(formId, message) {
    const errorEl = document.getElementById(`${formId}-error`);
    errorEl.textContent = message;
    errorEl.classList.add('show');
}

function showSuccess(formId, message) {
    const successEl = document.getElementById(`${formId}-success`);
    successEl.textContent = message;
    successEl.classList.add('show');
}

function setButtonLoading(buttonId, loading) {
    const btn = document.getElementById(buttonId);
    const text = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.spinner');
    
    btn.disabled = loading;
    text.style.display = loading ? 'none' : 'inline';
    spinner.style.display = loading ? 'inline-block' : 'none';
}

// Authentication Functions
async function handleSignup(e) {
    e.preventDefault();
    clearMessages();
    setButtonLoading('signup-btn', true);
    
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value.trim();
    const firstName = document.getElementById('signup-firstname').value.trim();
    const lastName = document.getElementById('signup-lastname').value.trim();
    
    // Client-side password validation
    const passwordError = validatePasswordRequirements(password);
    if (passwordError) {
        showError('signup', passwordError);
        setButtonLoading('signup-btn', false);
        return;
    }
    
    try {
        const response = await fetch(COGNITO_DOMAIN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.SignUp'
            },
            body: JSON.stringify({
                ClientId: COGNITO_CONFIG.ClientId,
                Username: email,
                Password: password,
                UserAttributes: [
                    { Name: 'email', Value: email },
                    { Name: 'given_name', Value: firstName },
                    { Name: 'family_name', Value: lastName }
                ]
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            // Handle case where user exists but is unconfirmed
            if (data.__type === 'UsernameExistsException') {
                pendingVerificationEmail = email;
                pendingVerificationPassword = password;
                // Resend verification code
                await resendVerificationCode(email);
                showSuccess('signup', 'Verification code sent! Please check your email.');
                setTimeout(() => showVerification(email), 2000);
                return;
            }
            throw new Error(data.message || data.__type || 'Signup failed');
        }
        
        // Preserve credentials for post-verification authentication
        pendingVerificationEmail = email;
        pendingVerificationPassword = password;
        
        showSuccess('signup', 'Account created! Please check your email for the verification code.');
        setTimeout(() => showVerification(email), 2000);
        
    } catch (error) {
        console.error('Signup error:', error);
        showError('signup', formatErrorMessage(error.message));
    } finally {
        setButtonLoading('signup-btn', false);
    }
}

async function handleVerification(e) {
    e.preventDefault();
    clearMessages();
    setButtonLoading('verify-btn', true);
    
    const code = document.getElementById('verification-code').value.trim();
    
    try {
        const response = await fetch(COGNITO_DOMAIN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.ConfirmSignUp'
            },
            body: JSON.stringify({
                ClientId: COGNITO_CONFIG.ClientId,
                Username: pendingVerificationEmail,
                ConfirmationCode: code
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || data.__type || 'Verification failed');
        }
        
        // Auto-login after successful verification
        if (pendingVerificationPassword) {
            await performLogin(pendingVerificationEmail, pendingVerificationPassword);
        } else {
            showLogin();
        }
        
    } catch (error) {
        console.error('Verification error:', error);
        showError('verification', formatErrorMessage(error.message));
    } finally {
        setButtonLoading('verify-btn', false);
    }
}

async function resendVerificationCode(email) {
    const response = await fetch(COGNITO_DOMAIN, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AWSCognitoIdentityProviderService.ResendConfirmationCode'
        },
        body: JSON.stringify({
            ClientId: COGNITO_CONFIG.ClientId,
            Username: email || pendingVerificationEmail
        })
    });
    
    if (!response.ok) {
        throw new Error('Failed to resend verification code');
    }
}

async function handleResendCode(e) {
    e.preventDefault();
    clearMessages();
    
    try {
        await resendVerificationCode();
        showSuccess('verification', 'Verification code resent! Check your email.');
    } catch (error) {
        console.error('Resend error:', error);
        showError('verification', 'Failed to resend code. Please try again.');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    clearMessages();
    setButtonLoading('login-btn', true);
    
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();
    
    try {
        await performLogin(email, password);
    } catch (error) {
        console.error('Login error:', error);
        
        // Check if user needs to verify email
        if (error.message.includes('UserNotConfirmedException')) {
            pendingVerificationEmail = email;
            pendingVerificationPassword = password;
            showError('login', 'Please verify your email first.');
            setTimeout(() => showVerification(email), 2000);
        } else {
            showError('login', formatErrorMessage(error.message));
        }
    } finally {
        setButtonLoading('login-btn', false);
    }
}

async function performLogin(email, password) {
    // Initiate authentication flow with AWS Cognito
    const authResponse = await fetch(COGNITO_DOMAIN, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
        },
        body: JSON.stringify({
            ClientId: COGNITO_CONFIG.ClientId,
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: {
                USERNAME: email,
                PASSWORD: password
            }
        })
    });
    
    const authData = await authResponse.json();
    
    if (!authResponse.ok) {
        throw new Error(authData.message || authData.__type || 'Login failed');
    }
    
    // Store tokens
    const tokens = authData.AuthenticationResult;
    // Use IdToken for authentication (contains user claims like email), AccessToken is for resource access
    await chrome.storage.local.set({
        authToken: tokens.IdToken,
        accessToken: tokens.AccessToken,
        refreshToken: tokens.RefreshToken,
        userEmail: email,
        tokenExpiry: Date.now() + (tokens.ExpiresIn * 1000)
    });
    
    // Redirect to sidepanel after successful authentication
    window.location.href = 'sidepanel.html';
}

function validatePasswordRequirements(password) {
    const missing = [];
    if (password.length < 8) missing.push("8+ characters");
    if (!/[A-Z]/.test(password)) missing.push("an uppercase letter");
    if (!/[a-z]/.test(password)) missing.push("a lowercase letter");
    if (!/[0-9]/.test(password)) missing.push("a number");
    
    // Check for special characters (allowing typical symbols). 
    // \W matches any non-word character (symbol or space). _ is a word char but often considered special in pw policies.
    if (!/[\W_]/.test(password)) missing.push("a special character");

    if (missing.length > 0) {
        return "Your password must include: " + missing.join(", ");
    }
    return null;
}

// Utility function to format error messages
function formatErrorMessage(message) {
    // Map common Cognito errors to user-friendly messages
    const errorMap = {
        'UsernameExistsException': 'An account with this email already exists.',
        'UserNotConfirmedException': 'Please verify your email address.',
        'NotAuthorizedException': 'Incorrect email or password.',
        'UserNotFoundException': 'No account found with this email.',
        'InvalidPasswordException': 'Password must be at least 8 characters.',
        'CodeMismatchException': 'Invalid verification code.',
        'ExpiredCodeException': 'Verification code has expired. Please request a new one.',
        'TooManyRequestsException': 'Too many attempts. Please try again later.',
        'InvalidParameterException': 'Invalid input. Please check your information.'
    };
    
    for (const [key, value] of Object.entries(errorMap)) {
        if (message.includes(key)) {
            return value;
        }
    }
    
    // Remove "Password did not conform with policy: " prefix
    if (message.includes('Password did not conform with policy:')) {
        return message.replace('Password did not conform with policy: ', '');
    }
    
    // Handle regex constraint errors (e.g. leading/trailing spaces)
    if (message.includes("failed to satisfy constraint: Member must satisfy regular expression pattern")) {
        return 'Password cannot contain leading or trailing spaces.';
    }

    return message;
}

// Refresh token function
async function refreshAccessToken() {
    try {
        const result = await chrome.storage.local.get(['refreshToken', 'userEmail']);
        
        if (!result.refreshToken) {
            throw new Error('No refresh token available');
        }
        
        const response = await fetch(COGNITO_DOMAIN, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
            },
            body: JSON.stringify({
                ClientId: COGNITO_CONFIG.ClientId,
                AuthFlow: 'REFRESH_TOKEN_AUTH',
                AuthParameters: {
                    REFRESH_TOKEN: result.refreshToken
                }
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.message || 'Token refresh failed');
        }
        
        // Update tokens
        const tokens = data.AuthenticationResult;
        await chrome.storage.local.set({
            authToken: tokens.IdToken,
            accessToken: tokens.AccessToken,
            tokenExpiry: Date.now() + (tokens.ExpiresIn * 1000)
        });
        
        return tokens.IdToken;
        
    } catch (error) {
        console.error('Token refresh error:', error);
        // If refresh fails, logout user
        await chrome.storage.local.remove(['authToken', 'accessToken', 'refreshToken', 'userEmail', 'tokenExpiry']);
        throw error;
    }
}

// Authentication module integration
window.CognitoAuth = {
    checkAuth: async function() {
        const result = await chrome.storage.local.get(['authToken', 'tokenExpiry', 'refreshToken']);
        
        // Return false if no authentication token exists
        if (!result.authToken) {
            return false;
        }
        
        // If token expired but have refresh token, try to refresh
        if (result.tokenExpiry < Date.now()) {
            if (result.refreshToken) {
                try {
                    await refreshAccessToken();
                    return true;
                } catch (error) {
                    return false;
                }
            }
            return false;
        }
        
        return true;
    },
    
    getAuthToken: async function() {
        const result = await chrome.storage.local.get(['authToken', 'tokenExpiry', 'refreshToken']);
        
        // If token expired, try to refresh
        if (result.authToken && result.tokenExpiry < Date.now() && result.refreshToken) {
            try {
                return await refreshAccessToken();
            } catch (error) {
                return null;
            }
        }
        
        return result.authToken || null;
    },
    
    refreshToken: refreshAccessToken,
    
    logout: async function() {
        await chrome.storage.local.remove(['authToken', 'accessToken', 'refreshToken', 'userEmail', 'tokenExpiry']);
        window.location.href = 'login.html';
    }
};
