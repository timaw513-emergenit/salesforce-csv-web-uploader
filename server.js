require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parse');
const jsforce = require('jsforce');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Salesforce OAuth configuration
const oauth2 = new jsforce.OAuth2({
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`
});

// Routes

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Salesforce OAuth login
app.get('/auth/salesforce', (req, res) => {
  const authUrl = oauth2.getAuthorizationUrl({
    scope: 'api id web refresh_token'
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const conn = new jsforce.Connection({ oauth2 });
    const userInfo = await conn.authorize(code);
    
    // Store connection info in session
    req.session.salesforce = {
      accessToken: conn.accessToken,
      instanceUrl: conn.instanceUrl,
      userInfo: userInfo,
      authMethod: 'oauth'
    };
    
    res.redirect('/?auth=success');
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect('/?auth=error');
  }
});

// Session ID authentication
app.post('/api/auth/session', async (req, res) => {
  const { sessionId, instanceUrl } = req.body;
  
  if (!sessionId || !instanceUrl) {
    return res.status(400).json({ error: 'Session ID and Instance URL are required' });
  }
  
  try {
    // Test the session by making a simple API call
    const conn = new jsforce.Connection({
      serverUrl: instanceUrl,
      sessionId: sessionId
    });
    
    // Verify the session by getting user info
    const userInfo = await conn.identity();
    
    // Store connection info in session
    req.session.salesforce = {
      accessToken: sessionId,
      instanceUrl: instanceUrl,
      userInfo: userInfo,
      authMethod: 'session'
    };
    
    res.json({ 
      success: true, 
      userInfo: userInfo,
      message: 'Successfully authenticated with session ID'
    });
    
  } catch (error) {
    console.error('Session authentication error:', error);
    res.status(401).json({ 
      error: 'Invalid session ID or instance URL. Please check your credentials.' 
    });
  }
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  if (req.session.salesforce) {
    res.json({ 
      authenticated: true, 
      userInfo: req.session.salesforce.userInfo,
      authMethod: req.session.salesforce.authMethod
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get current user's Salesforce session info (for easy copying)
app.get('/api/auth/session-info', (req, res) => {
  if (!req.session.salesforce) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  res.json({
    sessionId: req.session.salesforce.accessToken,
    instanceUrl: req.session.salesforce.instanceUrl,
    authMethod: req.session.salesforce.authMethod
  });
});

// Get Salesforce objects
app.get('/api/salesforce/objects', async (req, res) => {
  if (!req.session.salesforce) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const conn = new jsforce.Connection({
      serverUrl: req.session.salesforce.instanceUrl,
      sessionId: req.session.salesforce.accessToken
    });
    
    const objects = await conn.describeGlobal();
    const customObjects = objects.sobjects
      .filter(obj => obj.createable && obj.updateable)
      .map(obj => ({
        name: obj.name,
        label: obj.label,
        custom: obj.custom
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    
    res.json(customObjects);
  } catch (error) {
    console.error('Error fetching objects:', error);
    res.status(500).json({ error: 'Failed to fetch Salesforce objects' });
  }
});

// Get object fields
app.get('/api/salesforce/objects/:objectName/fields', async (req, res) => {
  if (!req.session.salesforce) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const conn = new jsforce.Connection({
      serverUrl: req.session.salesforce.instanceUrl,
      sessionId: req.session.salesforce.accessToken
    });
    
    const objectDesc = await conn.describe(req.params.objectName);
    const fields = objectDesc.fields
      .filter(field => field.createable || field.updateable)
      .map(field => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: !field.nillable && !field.defaultedOnCreate,
        picklistValues: field.picklistValues
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    
    res.json(fields);
  } catch (error) {
    console.error('Error fetching fields:', error);
    res.status(500).json({ error: 'Failed to fetch object fields' });
  }
});

// Upload and process CSV
app.post('/api/upload', upload.single('csvFile'), async (req, res) => {
  if (!req.session.salesforce) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const { objectName, operation, externalIdField } = req.body;
  
  try {
    const conn = new jsforce.Connection({
      serverUrl: req.session.salesforce.instanceUrl,
      sessionId: req.session.salesforce.accessToken
    });
    
    // Parse CSV file
    const csvData = fs.readFileSync(req.file.path, 'utf8');
    const records = [];
    
    await new Promise((resolve, reject) => {
      csv.parse(csvData, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
      .on('data', (row) => {
        // Clean up the row data
        const cleanRow = {};
        Object.keys(row).forEach(key => {
          const cleanKey = key.trim();
          const value = row[key];
          if (value !== null && value !== undefined && value !== '') {
            cleanRow[cleanKey] = value;
          }
        });
        if (Object.keys(cleanRow).length > 0) {
          records.push(cleanRow);
        }
      })
      .on('end', resolve)
      .on('error', reject);
    });
    
    if (records.length === 0) {
      throw new Error('No valid records found in CSV file');
    }
    
    // Perform Salesforce operation
    let result;
    switch (operation) {
      case 'insert':
        result = await conn.sobject(objectName).create(records);
        break;
      case 'update':
        result = await conn.sobject(objectName).update(records);
        break;
      case 'upsert':
        if (!externalIdField) {
          throw new Error('External ID field is required for upsert operation');
        }
        result = await conn.sobject(objectName).upsert(records, externalIdField);
        break;
      default:
        throw new Error('Invalid operation');
    }
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    // Process results
    const results = Array.isArray(result) ? result : [result];
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);
    
    res.json({
      success: true,
      totalRecords: records.length,
      successful: successful,
      failed: failed.length,
      errors: failed.map(f => ({
        id: f.id,
        errors: f.errors
      }))
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the application at http://localhost:${PORT}`);
});