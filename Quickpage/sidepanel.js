let includedImages = [];
let isWaitingForResponse = false;
let currentSessionId = null;
let currentPageContent = null;
let authToken = null;
const API_ENDPOINT = 'https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod';
let lastPreloadedURL = null;  // Track last preloaded page to avoid duplicates
let preloadedPageContent = null;  // Store preloaded content to reuse for queries
let contentReady = false;  // Flag to indicate content extraction is complete

// Initialize side panel on first load
if (!window.sidePanelInitialized) {
  document.addEventListener('DOMContentLoaded', async () => {
    // Verify user authentication status
    await checkAuthentication();
    
    initializeContent();
    setupSessionManagement();
    setupInputHandlers();
    window.sidePanelInitialized = true;
  });
}

// Verify and refresh user authentication
async function checkAuthentication() {
  let result = await chrome.storage.local.get(['authToken', 'accessToken', 'tokenExpiry', 'refreshToken', 'userEmail']);
  
  // Redirect to login if no authentication token exists
  if (!result.authToken) {
    window.location.href = 'login.html';
    return false;
  }
  
  // Refresh expired authentication token
  if (result.tokenExpiry < Date.now()) {
    if (result.refreshToken) {
      try {
        await refreshAccessToken();
        const newTokens = await chrome.storage.local.get(['authToken', 'accessToken']);
        authToken = newTokens.authToken;
        result.accessToken = newTokens.accessToken; // Update local result for displayUserProfile
      } catch (error) {
        console.error('Token refresh failed:', error);
        window.location.href = 'login.html';
        return false;
      }
    } else {
      window.location.href = 'login.html';
      return false;
    }
  } else {
    authToken = result.authToken;
  }
  
  // Fetch and display user attributes
  await displayUserProfile(result.accessToken || result.authToken);
  
  // Add logout button handler if it exists
  const logoutBtn = document.getElementById('logout-button');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
  
  // Add delete account button handler
  const deleteAccountBtn = document.getElementById('delete-account-button');
  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', handleDeleteAccount);
  }
  
  return true;
}

async function displayUserProfile(accessToken) {
  try {
    const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetUser'
      },
      body: JSON.stringify({
        AccessToken: accessToken
      })
    });
    
    const data = await response.json();
    
    if (response.ok && data.UserAttributes) {
      const givenName = data.UserAttributes.find(attr => attr.Name === 'given_name')?.Value;
      const familyName = data.UserAttributes.find(attr => attr.Name === 'family_name')?.Value;
      const email = data.UserAttributes.find(attr => attr.Name === 'email')?.Value;
      
      // Display user name
      const userNameEl = document.getElementById('user-name');
      if (userNameEl && givenName) {
        userNameEl.textContent = givenName;
      }
      
      // Display initials in avatar
      const userAvatarEl = document.getElementById('user-avatar');
      if (userAvatarEl) {
        const initials = (givenName?.charAt(0) || '') + (familyName?.charAt(0) || '');
        userAvatarEl.textContent = initials.toUpperCase() || email?.charAt(0).toUpperCase() || 'U';
      }
    }
  } catch (error) {
    console.error('Failed to fetch user profile:', error);
  }
}

async function handleLogout() {
  await chrome.storage.local.remove(['authToken', 'accessToken', 'refreshToken', 'userEmail', 'tokenExpiry']);
  window.location.href = 'login.html';
}

async function handleDeleteAccount() {
  const confirmed = confirm(
    'Are you sure you want to delete your account?\n\n' +
    'This will permanently delete:\n' +
    '• Your account and profile\n' +
    '• All chat history\n' +
    '• All saved conversations\n\n' +
    'This action cannot be undone.'
  );
  
  if (!confirmed) return;
  
  try {
    const result = await chrome.storage.local.get(['accessToken']);
    
    if (!result.accessToken) {
      alert('Session expired. Please login again.');
      window.location.href = 'login.html';
      return;
    }
    
    // Call Cognito DeleteUser API
    const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.DeleteUser'
      },
      body: JSON.stringify({
        AccessToken: result.accessToken
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to delete account');
    }
    
    // Clear all local data
    await chrome.storage.local.clear();
    
    alert('Your account has been deleted successfully.');
    window.location.href = 'login.html';
    
  } catch (error) {
    console.error('Delete account error:', error);
    alert('Failed to delete account: ' + error.message);
  }
}

// Refresh token function
async function refreshAccessToken() {
  const COGNITO_DOMAIN = 'https://cognito-idp.us-east-1.amazonaws.com';
  const COGNITO_CLIENT_ID = 'your-app-client-id';
  
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
        ClientId: COGNITO_CLIENT_ID,
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
    throw error;
  }
}



function setupSessionManagement() {
  // Configure sidebar toggle functionality
  document.getElementById('hamburger-button').addEventListener('click', toggleSidebar);
  document.getElementById('close-sidebar-button').addEventListener('click', toggleSidebar);
  
  // Auto-close sidebar on chat area interaction
  document.getElementById('chat-container').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) {
      toggleSidebar();
    }
  });
  
  // New chat button
  document.getElementById('new-chat-button').addEventListener('click', createNewChat);
  
  // Close panel button
  const closePanelBtn = document.getElementById('close-panel-button');
  if (closePanelBtn) {
    closePanelBtn.addEventListener('click', () => {
      window.close();
    });
  }
  
  // Initialize or restore session
  initializeSession();
  
  // Load session list
  loadSessionList();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('open');
}

async function initializeSession() {
  // Create new conversation session for each extension instance
  await createNewChat();
}

async function createNewChat() {
  // Preserve current session if it contains messages
  if (currentSessionId) {
    const chatContainer = document.getElementById('chat-container');
    const messages = chatContainer.querySelectorAll('.message-row');
  }
  
  // Initialize new conversation session
  currentSessionId = generateUUID();
  localStorage.setItem('current_session_id', currentSessionId);
  
  // Reset chat interface
  clearChatUI();
  
  // Reload session list
  await loadSessionList();
}

function clearChatUI() {
  const chatContainer = document.getElementById('chat-container');
  chatContainer.innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">👋</div>
      <h2>How can I help you with this page?</h2>
      <p>Ask me to summarize, extract data, or analyze images.</p>
    </div>
  `;
}

async function loadSessionList() {
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'listSessions', authToken: authToken })
    });
    
    const data = await response.json();
    
    // Check for authentication errors
    if (data.statusCode === 401 || (data.body && typeof data.body === 'string' && JSON.parse(data.body).error?.includes('authentication token'))) {
      console.error('Authentication error - redirecting to login');
      window.location.href = 'login.html';
      return;
    }
    
    const body = typeof data.body === 'string' ? JSON.parse(data.body) : data.body || data;
    
    const sessions = body.sessions || [];
    
    const sessionList = document.getElementById('session-list');
    sessionList.innerHTML = '';
    
    if (sessions.length === 0) {
      sessionList.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 12px;">No chat history yet</div>';
      return;
    }
    
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item';
      if (session.session_id === currentSessionId) {
        item.classList.add('active');
      }
      
      const date = new Date(session.lastMessageAt);
      const timeAgo = getTimeAgo(date);
      
      const sessionInfo = document.createElement('div');
      sessionInfo.className = 'session-info';
      sessionInfo.innerHTML = `
        <div class="session-title"><span>${escapeHtml(session.sessionTitle)}</span></div>
        <div class="session-meta">
          <span>${timeAgo}</span>
        </div>
      `;
      
      // Handle hover scroll for long titles
      const titleDiv = sessionInfo.querySelector('.session-title');
      const titleSpan = titleDiv.querySelector('span');
      
      item.addEventListener('mouseenter', () => {
        const overflow = titleSpan.offsetWidth - titleDiv.offsetWidth;
        if (overflow > 0) {
          // Set custom property for scroll distance (adding some padding)
          titleDiv.style.setProperty('--scroll-distance', `-${overflow + 5}px`);
          // Calculate duration based on text length (slower is better for reading)
          const duration = Math.max(3, overflow * 0.05);
          titleSpan.style.animationDuration = `${duration}s`;
          titleDiv.classList.add('scrolling');
        }
      });
      
      item.addEventListener('mouseleave', () => {
        titleDiv.classList.remove('scrolling');
      });
      
      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      deleteBtn.title = 'Delete chat';
      
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(session.session_id);
      });
      
      sessionInfo.addEventListener('click', () => loadSession(session.session_id));
      
      item.appendChild(sessionInfo);
      item.appendChild(deleteBtn);
      sessionList.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading session list:', error);
  }
}

async function loadSession(sessionId) {
  // Close sidebar immediately for better UX
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    toggleSidebar();
  }

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getSession', session_id: sessionId, authToken: authToken })
    });
    
    const data = await response.json();
    
    // Check for authentication errors
    if (data.statusCode === 401 || (data.body && typeof data.body === 'string' && JSON.parse(data.body).error?.includes('authentication token'))) {
      console.error('Authentication error - redirecting to login');
      window.location.href = 'login.html';
      return;
    }
    
    const body = typeof data.body === 'string' ? JSON.parse(data.body) : data.body || data;
    
    if (body.error) {
      console.error('Error loading session:', body.error);
      return;
    }
    
    // Set as current session
    currentSessionId = sessionId;
    localStorage.setItem('current_session_id', currentSessionId);
    
    // Restore page content from session
    if (body.session && body.session.pageContent) {
      currentPageContent = body.session.pageContent;
    }
    
    // Clear and rebuild UI
    const chatContainer = document.getElementById('chat-container');
    chatContainer.innerHTML = '';
    
    // Restore messages
    body.messages.forEach(msg => {
      // Display image if ImageURL exists, otherwise display question text
      if (msg.ImageURL) {
        appendMessage('user', msg.ImageURL, true);
      } else if (msg.question) {
        appendMessage('user', msg.question);
      }
      
      if (msg.answer) {
        appendMessage('bot', msg.answer);
      }
    });
    
    // Update session list to show active
    await loadSessionList();
  } catch (error) {
    console.error('Error loading session:', error);
  }
}

async function deleteSession(sessionId) {
  const confirmDelete = confirm('Are you sure you want to delete this chat?');
  
  if (!confirmDelete) return;
  
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', session_id: sessionId, authToken: authToken })
    });
    
    const data = await response.json();
    
    // Check for authentication errors
    if (data.statusCode === 401 || (data.body && typeof data.body === 'string' && JSON.parse(data.body).error?.includes('authentication token'))) {
      console.error('Authentication error - redirecting to login');
      window.location.href = 'login.html';
      return;
    }
    
    // If we deleted the current session, create a new one
    if (sessionId === currentSessionId) {
      await createNewChat();
    }
    
    // Reload session list
    await loadSessionList();
    
  } catch (error) {
    console.error('Error deleting session:', error);
    alert('Failed to delete chat. Please try again.');
  }
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


function initializeContent() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      function: extractContent
    }, (results) => {
      if (results && results[0]) {
        window.extractedContent = results[0].result;
        preloadedPageContent = results[0].result;  // Store for reuse
        contentReady = true;  // Mark content as ready
        
        // Preload embeddings in the background
        const pageURL = tabs[0].url;
        if (pageURL && pageURL !== lastPreloadedURL) {
          // Execute asynchronously without blocking execution
          preloadEmbeddings(results[0].result, pageURL).catch(err => {
            console.error('Preload error (non-blocking):', err);
          });
          lastPreloadedURL = pageURL;
        }
      } else {
        console.error("No content extracted.");
      }
    });
  });
}

// Preload embeddings in background to make first query instant
async function preloadEmbeddings(pageContent, pageURL) {
  try {
    // Execute request without explicit timeout handling
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'preloadEmbeddings',
        pageContent: pageContent,
        pageURL: pageURL,
        authToken: authToken
      })
    });
    
    const data = await response.json();
    const body = typeof data.body === 'string' ? JSON.parse(data.body) : data.body || data;
  } catch (error) {
    console.error('Preload failed:', error);
  }
}

function setupInputHandlers() {
  const textarea = document.getElementById('question-input');
  const askButton = document.getElementById('ask-button');

  // Auto-resize textarea
  textarea.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    
    // Enable/disable button
    if (this.value.trim().length > 0) {
      askButton.removeAttribute('disabled');
    } else {
      askButton.setAttribute('disabled', 'true');
    }
  });

  // Handle Enter key
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!askButton.disabled) {
        handleAskButtonClick();
      }
    }
  });

  askButton.addEventListener('click', handleAskButtonClick);
}

function appendMessage(type, content, isImage = false) {
  const chatContainer = document.getElementById('chat-container');
  const welcomeMessage = document.querySelector('.welcome-message');
  
  if (welcomeMessage) {
    welcomeMessage.style.display = 'none';
  }

  const messageRow = document.createElement('div');
  messageRow.className = `message-row ${type}`;

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (type === 'bot') {
    const img = document.createElement('img');
    img.src = 'Quickpage-short.svg';
    img.alt = 'QuickPage';
    img.style.width = '100%';
    img.style.height = '100%';
    avatar.appendChild(img);
  }
  
  // Content
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  if (isImage) {
    const img = document.createElement('img');
    img.src = content;
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    messageContent.appendChild(img);
  } else {
    // Basic markdown parsing implementation for code block rendering
    if (content.includes('```')) {
      const parts = content.split('```');
      parts.forEach((part, index) => {
        if (index % 2 === 1) {
          // Code block
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = part.trim(); // Remove leading/trailing newlines
          pre.appendChild(code);
          messageContent.appendChild(pre);
        } else {
          // Text
          const textSpan = document.createElement('span');
          textSpan.innerText = part;
          messageContent.appendChild(textSpan);
        }
      });
    } else {
      messageContent.innerText = content;
    }
  }

  messageRow.appendChild(avatar);
  messageRow.appendChild(messageContent);
  chatContainer.appendChild(messageRow);
  
  // Scroll to bottom
  chatContainer.scrollTop = chatContainer.scrollHeight;
  
  return messageRow;
}

// Streaming text display function
async function appendStreamingMessage(type, fullText) {
  const chatContainer = document.getElementById('chat-container');
  const welcomeMessage = document.querySelector('.welcome-message');
  
  if (welcomeMessage) {
    welcomeMessage.style.display = 'none';
  }

  const messageRow = document.createElement('div');
  messageRow.className = `message-row ${type}`;

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (type === 'bot') {
    const img = document.createElement('img');
    img.src = 'Quickpage-short.svg';
    img.alt = 'QuickPage';
    img.style.width = '100%';
    img.style.height = '100%';
    avatar.appendChild(img);
  }
  
  // Content
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';

  messageRow.appendChild(avatar);
  messageRow.appendChild(messageContent);
  chatContainer.appendChild(messageRow);

  // Stream the text word by word
  let currentText = '';
  const words = fullText.split(' ');
  
  for (let i = 0; i < words.length; i++) {
    currentText += (i > 0 ? ' ' : '') + words[i];
    
    // Handle code blocks in the text
    if (currentText.includes('```')) {
      const parts = currentText.split('```');
      messageContent.innerHTML = '';
      parts.forEach((part, index) => {
        if (index % 2 === 1) {
          // Code block
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = part.trim();
          pre.appendChild(code);
          messageContent.appendChild(pre);
        } else {
          // Text
          const textSpan = document.createElement('span');
          textSpan.textContent = part;
          messageContent.appendChild(textSpan);
        }
      });
    } else {
      messageContent.textContent = currentText;
    }
    
    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    // Delay between words (adjust for desired speed)
    // Typing speed configuration (approx. 30ms per word)
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  
  // Final pass - ensure complete text is displayed
  if (fullText.includes('```')) {
    const parts = fullText.split('```');
    messageContent.innerHTML = '';
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = part.trim();
        pre.appendChild(code);
        messageContent.appendChild(pre);
      } else {
        const textSpan = document.createElement('span');
        textSpan.textContent = part;
        messageContent.appendChild(textSpan);
      }
    });
  } else {
    messageContent.textContent = fullText;
  }
  
  chatContainer.scrollTop = chatContainer.scrollHeight;
  
  return messageRow;
}

function showTypingIndicator() {
  const chatContainer = document.getElementById('chat-container');
  const messageRow = document.createElement('div');
  messageRow.className = 'message-row bot typing-row';
  messageRow.id = 'typing-indicator-row';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  const img = document.createElement('img');
  img.src = 'Quickpage-short.svg';
  img.alt = 'QuickPage';
  img.style.width = '100%';
  img.style.height = '100%';
  avatar.appendChild(img);

  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;

  messageContent.appendChild(indicator);
  messageRow.appendChild(avatar);
  messageRow.appendChild(messageContent);
  chatContainer.appendChild(messageRow);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typing-indicator-row');
  if (indicator) {
    indicator.remove();
  }
}

// Modify the handleAskButtonClick function
function handleAskButtonClick() {
  if (isWaitingForResponse) return;

  const queryStartTime = Date.now();

  const input = document.getElementById('question-input');
  const question = input.value.trim();
  const askButton = document.getElementById('ask-button');

  if (question) {
    // Use current session ID
    if (!currentSessionId) {
      currentSessionId = generateUUID();
      localStorage.setItem('current_session_id', currentSessionId);
    }
    
    // Display user message
    appendMessage('user', question);

    // Reset input
    input.value = '';
    input.style.height = 'auto';
    askButton.setAttribute('disabled', 'true');

    // Show loading indicator
    isWaitingForResponse = true;
    showTypingIndicator();

    // Fetch answer from the backend
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const currentURL = tabs[0].url;
      
      // Wait for content extraction to complete (maximum 5 seconds)
      let waitCount = 0;
      while (!contentReady && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      
      // Check if it's a browser internal page
      const internalPagePrefixes = ['chrome://', 'brave://', 'edge://', 'about:', 'chrome-extension://', 'edge-extension://'];
      const isInternalPage = internalPagePrefixes.some(prefix => currentURL.startsWith(prefix));
      
      if (isInternalPage) {
        removeTypingIndicator();
        isWaitingForResponse = false;
        appendMessage('bot', '⚠️ Cannot analyze browser internal pages. Please navigate to a regular website (http:// or https://) to use QuickPage.');
        const askButton = document.getElementById('ask-button');
        askButton.removeAttribute('disabled');
        return;
      }
      
      // Reuse preloaded content if available to ensure hash matches
      if (preloadedPageContent) {
        sendQueryToLambda(tabs[0].url, preloadedPageContent, question, queryStartTime);
      } else {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          function: extractContent
        }, (results) => {
          if (results && results[0]) {
            sendQueryToLambda(tabs[0].url, results[0].result, question, queryStartTime);
          } else {
            removeTypingIndicator();
            isWaitingForResponse = false;
            console.error("Failed to extract page content");
          }
        });
      }
    });
  }
}

async function sendQueryToLambda(pageURL, pageContent, question, queryStartTime) {
  const fetchStartTime = Date.now();
  
  // Refresh token if expiring soon (within 1 minute)
  const tokenCheck = await chrome.storage.local.get(['tokenExpiry', 'refreshToken']);
  if (tokenCheck.tokenExpiry && tokenCheck.tokenExpiry < Date.now() + 60000) {
    if (tokenCheck.refreshToken) {
      try {
        authToken = await refreshAccessToken();
      } catch (error) {
        console.error('Failed to refresh token:', error);
        window.location.href = 'login.html';
        return;
      }
    }
  }
  
  // Include the image URLs in the context
  const imageContext = includedImages.join('\n');
  const prompt = `${question}`;
  
  const apiEndpoint = API_ENDPOINT;

  fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_id: currentSessionId, 
      pageContent, 
      prompt, 
      imageContext, 
      pageURL, 
      action: 'ask',
      authToken: authToken
    }),
  })
    .then(response => response.json())
    .then(data => {
      removeTypingIndicator();
      isWaitingForResponse = false;
      
      
      // Check for authentication errors (401)
      if (data.statusCode === 401) {
        console.error('Authentication error - redirecting to login');
        window.location.href = 'login.html';
        return;
      }
      
      // Parse the response - handle API Gateway proxy integration
      let answer;
      if (data.body) {
        // API Gateway format - body is stringified JSON
        const bodyData = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
        
        // Check for authentication error in body
        if (bodyData.error && bodyData.error.includes('authentication token')) {
          console.error('Authentication error - redirecting to login');
          window.location.href = 'login.html';
          return;
        }
        
        answer = bodyData.response || bodyData.error || 'No response received';
      } else if (data.response) {
        // Direct response
        answer = data.response;
      } else if (data.error) {
        // Error response - check for auth error
        if (data.error.includes('authentication token')) {
          console.error('Authentication error - redirecting to login');
          window.location.href = 'login.html';
          return;
        }
        answer = data.error;
      } else if (data.message) {
        // API Gateway timeout or other message
        answer = `Request timed out. The page might be too large or complex. Try asking a simpler question.`;
        console.error('Gateway message:', data.message);
      } else if (data.errorMessage) {
        // Lambda error
        answer = data.errorMessage;
        console.error('Lambda error:', data);
      } else {
        console.error('Unexpected response format:', data);
        answer = `Unexpected response format. Check console for details.`;
      }

      // Use streaming display for bot messages
      appendStreamingMessage('bot', answer).then(() => {
        // Reload session list to update with new message
        loadSessionList();
      });
      
      // Clear images
      includedImages = [];
    })
    .catch(error => {
      console.error('Error:', error);
      removeTypingIndicator();
      isWaitingForResponse = false;
      appendMessage('bot', 'Sorry, I encountered an error while processing your request.');
    });
}

// Function to extract content from the webpage
function extractContent() {
  return {
    text: document.body.innerText || ''
  };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // Re-extract content when page loads
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id === tabId) {
        const newURL = tabs[0].url;
        
        // Re-extract content if URL has changed
        if (newURL !== lastPreloadedURL) {
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            function: extractContent
          }, (results) => {
            if (results && results[0]) {
              window.extractedContent = results[0].result;
              preloadedPageContent = results[0].result;
              contentReady = true;
              
              // Preload embeddings for the new page
              preloadEmbeddings(results[0].result, newURL).catch(err => {
                console.error('Preload error:', err);
              });
              lastPreloadedURL = newURL;
            }
          });
        }
      }
    });
  }
});

// Modify the existing chrome.runtime.onMessage listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "addImageToChat") {
    appendMessage('user', request.imageUrl, true);
    includedImages.push(request.imageUrl);
  } else if (request.action === "closeSidePanel") {
    window.close();
  }
});





