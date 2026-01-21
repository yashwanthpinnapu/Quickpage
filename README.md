<div align="center">
  <img src="Quickpage/Quickpage-long.svg" alt="Quickpage Logo" width="300">
  
  <p>Your AI companion to understand any webpage instantly.</p>
  
  <p>
    <a href="#features">Features</a> •
    <a href="#setup">Setup</a> •
    <a href="#usage">Usage</a> •
    <a href="#how-it-works">How It Works</a>
  </p>
</div>

---

## Overview

Quickpage is a Chrome extension that lets you ask questions about any webpage or analyze images from it using AI. Your chat history is saved to the cloud, so you can pick up where you left off on any device.


## Features

**Page Analysis**  
Ask questions about the content on any webpage and get answers based on what's actually there.

**Multi-Page Context**  
Browse through multiple pages in a session. Quickpage remembers all pages you've visited and can answer questions about any of them.

**Image Understanding**  
Analyze images from the current page. The AI can describe what's in them or answer specific questions about visual content.

**Chat History**  
Your conversations are stored in DynamoDB and accessible across devices when you're signed in.

**Session Management**  
Create multiple chat sessions, switch between them, or delete old ones.


## Try It Out

Want to test Quickpage before setting up your own infrastructure?

Download [Quickpage-Extension.zip](Quickpage-Extension.zip)

This is a ready-to-use demo version that connects to our backend. Just download, install, and start asking questions!

For installation help, see `INSTALL.html` in the Quickpage folder.


## Tech Stack

- **Frontend:** Vanilla JavaScript Chrome Extension
- **Backend:** AWS Lambda (Python, containerized with Docker)
- **AI:** AWS Bedrock with Llama 3.2 90B (handles both text and images)
- **Vector Search:** FAISS via LangChain for semantic retrieval
- **Auth:** AWS Cognito with email/password
- **Storage:** DynamoDB for chat history, S3 for embedding cache

## Prerequisites

You'll need:
- An AWS account with access to Lambda, Bedrock, DynamoDB, S3, Cognito, API Gateway, and ECR
- Docker installed locally
- AWS CLI configured
- Chrome browser

Make sure you have Llama 3.2 90B enabled in AWS Bedrock for your region.

## Setup

### 1. AWS Infrastructure

**DynamoDB Tables:**

Create two tables:
```
chatHistory
- Partition key: userId (String)
- Sort key: session_id (String)

pageEmbeddingsCache
- Partition key: cache_key (String)
```

**S3 Bucket:**
```bash
aws s3 mb s3://your-bucket-name --region us-east-1
```

**Cognito:**
- Create a User Pool with email/password authentication
- Create an App Client
- Save the Pool ID, Client ID, and Region

**ECR:**
```bash
aws ecr create-repository --repository-name quickpage-lambda --region us-east-1
```

### 2. Configure the Code

In `lambda_function.py`, update:
```python
CACHE_BUCKET = 'your-s3-bucket-name'
COGNITO_USER_POOL_ID = 'your-user-pool-id'
COGNITO_APP_CLIENT_ID = 'your-app-client-id'
```

In `Quickpage/auth.js`, update:
```javascript
const COGNITO_CONFIG = {
    Region: 'us-east-1',
    UserPoolId: 'your-user-pool-id',
    ClientId: 'your-app-client-id'
};
```

### 3. Deploy Lambda

```bash
# Build
docker build --platform linux/amd64 --provenance=false --sbom=false -t quickpage-lambda:latest .

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Tag and push
docker tag quickpage-lambda:latest YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/quickpage-lambda:latest
docker push YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/quickpage-lambda:latest

# Create function (or update if it exists)
aws lambda create-function \
  --function-name quickpage-handler \
  --package-type Image \
  --code ImageUri=YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/quickpage-lambda:latest \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_LAMBDA_ROLE \
  --memory-size 2048 \
  --timeout 120 \
  --region us-east-1
```

Make sure your Lambda role has permissions for DynamoDB, S3, Bedrock, and CloudWatch Logs.

### 4. API Gateway

- Create a REST API
- Add a POST method pointing to your Lambda
- Enable CORS (allow Origin: *, Headers: Content-Type,Authorization, Methods: POST,OPTIONS)
- Deploy to a stage like 'prod'
- Note the invoke URL

### 5. Install Extension

1. Go to `chrome://extensions/`
2. Turn on Developer mode
3. Click "Load unpacked"
4. Select the `Quickpage` folder
5. Done

## Usage

Click the Quickpage icon in Chrome to open the side panel. Sign up or sign in, then navigate to any page and start asking questions.

To analyze images, right-click on any image on the page and select "Ask about image" from the context menu. The image will be included in your chat where you can ask questions about it.


## How It Works

**For page questions:**
1. Text is extracted from the current page
2. Embeddings are created and cached (makes repeat questions faster)
3. Your question is sent to Lambda with relevant page context
4. Llama 3.2 90B generates an answer using retrieval-augmented generation

**For images:**
1. The image is captured from the page
2. Sent to Lambda (resized if needed)
3. Llama 3.2 90B (which supports vision) analyzes it
4. You get a response about what's in the image

**For authentication:**
- Cognito handles sign-up and login
- JWT tokens are verified server-side
- Chat history is tied to your user ID

## Project Structure

```
.
├── Quickpage/              # Browser extension
│   ├── manifest.json
│   ├── sidepanel.html
│   ├── sidepanel.js
│   ├── sidepanel.css
│   ├── background.js
│   ├── auth.js
│   ├── login.html
│   ├── login.css
│   └── logo files
├── lambda_function.py      # Backend logic
├── requirements.txt        # Python deps
├── Dockerfile             # For Lambda deployment
├── .env.template          # Config template
└── .gitignore
```

## Costs

⚠️ **Important:** AWS Bedrock has no free tier. You will incur charges from the first query.

Quickpage uses AWS services that bill per use:
- Bedrock (largest cost): Charges per token
- Lambda, DynamoDB, S3: Usually covered by free tier for light usage

The embedding cache helps reduce costs by avoiding redundant processing.
## Troubleshooting

**Extension won't load:**  
Check the console in `chrome://extensions/` for errors.

**Lambda timeouts:**  
Current config: 2GB memory, 120s timeout. If you experience timeouts, try increasing memory to 3GB and timeout to 300s. Check CloudWatch Logs for details.

**Auth errors:**  
Make sure Cognito config matches between `lambda_function.py` and `auth.js`.

**Image analysis fails:**  
Verify Bedrock access to Llama 3.2 90B. Large images are auto-resized, but very large ones might still timeout.

## Security & Privacy

**Authentication:** AWS Cognito with JWT token verification using JWKS (JSON Web Key Set)

**Data Storage:** 
- Chat history stored in DynamoDB (encrypted at rest)
- You can delete sessions anytime through the extension
- Data is isolated per user (you can only access your own chats)

## Contributing

Pull requests welcome. Please test your changes before submitting.

## License

Use it however you want.
