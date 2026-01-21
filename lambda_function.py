from PIL import Image
import boto3
import json
import requests
import base64
from io import BytesIO
import time
import uuid
from boto3.dynamodb.conditions import Key, Attr
import io
import os
import hashlib
import pickle
from decimal import Decimal
from jose import jwt, JWTError

from langchain_aws import ChatBedrock, BedrockEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document


# Helper to convert DynamoDB Decimal to native Python types
def decimal_to_int(obj):
    """Convert Decimal objects to int for JSON serialization."""
    if isinstance(obj, Decimal):
        return int(obj)
    raise TypeError

# Initialize the Bedrock client for AI inference
bedrock_runtime = boto3.client(
    service_name='bedrock-runtime',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

# Initialize S3 client for caching
s3_client = boto3.client('s3', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
CACHE_BUCKET = os.environ.get('S3_CACHE_BUCKET', 'your-embeddings-cache-bucket')

# Initialize DynamoDB resource and tables
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
table = dynamodb.Table(os.environ.get('DYNAMODB_CHAT_TABLE', 'chatHistory'))
cache_table = dynamodb.Table(os.environ.get('DYNAMODB_CACHE_TABLE', 'pageEmbeddingsCache'))

# AWS Bedrock model configuration
MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.meta.llama3-2-90b-instruct-v1:0')

# AWS Cognito authentication configuration
COGNITO_REGION = os.environ.get('COGNITO_REGION', 'us-east-1')
COGNITO_USER_POOL_ID = os.environ.get('COGNITO_USER_POOL_ID', 'your-user-pool-id')
COGNITO_APP_CLIENT_ID = os.environ.get('COGNITO_APP_CLIENT_ID', 'your-app-client-id')
COGNITO_KEYS_URL = f'https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}/.well-known/jwks.json'


def verify_cognito_token(token):
    """Verify and decode Cognito JWT token."""
    try:
        # Get the kid from the token header
        headers = jwt.get_unverified_headers(token)
        kid = headers['kid']
        
        # Get the public keys from Cognito
        response = requests.get(COGNITO_KEYS_URL)
        keys = response.json()['keys']
        
        # Find the key that matches the kid
        key = None
        for k in keys:
            if k['kid'] == kid:
                key = k
                break
        
        if not key:
            raise ValueError('Public key not found in jwks.json')
        
        # Verify and decode the token
        payload = jwt.decode(
            token,
            key,
            algorithms=['RS256'],
            audience=COGNITO_APP_CLIENT_ID,
            options={'verify_exp': True}
        )
        
        return payload
    except JWTError as e:
        return None
    except Exception as e:
        return None


def make_bedrock_llm(streaming=False):
    """Create a LangChain ChatBedrock LLM wrapper around Llama 3.2 90B."""
    return ChatBedrock(
        client=bedrock_runtime,
        model_id=MODEL_ID,
        model_kwargs={
            "temperature": 0.2,
            "max_tokens": 1024,
        },
        streaming=streaming,
    )


def load_retriever_from_hash(content_hash: str, page_url: str = None):
    """Attempt to load retriever from cache using content hash."""
    if not content_hash:
        return None
        
    s3_key = f"embeddings/{content_hash}/index.faiss"
    s3_pkl_key = f"embeddings/{content_hash}/index.pkl"
    temp_path = f"/tmp/faiss_{content_hash}"
    
    # Initialize embeddings model
    embeddings = BedrockEmbeddings(
        client=bedrock_runtime,
        model_id="amazon.titan-embed-text-v2:0",
    )
    
    # Attempt to load from local temporary storage
    if os.path.exists(f"{temp_path}/index.faiss") and os.path.exists(f"{temp_path}/index.pkl"):
        try:
            vector_store = FAISS.load_local(temp_path, embeddings, allow_dangerous_deserialization=True)
            return vector_store.as_retriever(search_kwargs={"k": 5})
        except Exception:
            pass
            
    # Attempt to load from S3 storage
    try:
        os.makedirs(temp_path, exist_ok=True)
        s3_client.download_file(CACHE_BUCKET, s3_key, f"{temp_path}/index.faiss")
        s3_client.download_file(CACHE_BUCKET, s3_pkl_key, f"{temp_path}/index.pkl")
        
        vector_store = FAISS.load_local(temp_path, embeddings, allow_dangerous_deserialization=True)
        return vector_store.as_retriever(search_kwargs={"k": 5})
    except:
        return None

def build_page_retriever(page_text: str, page_url: str = None):
    """Build retriever with cached embeddings in S3 for fast subsequent queries."""
    if not page_text:
        class EmptyRetriever:
            def get_relevant_documents(self, query):
                return []
        return EmptyRetriever()

    # Generate content hash for caching
    content_hash = hashlib.sha256(page_text.encode('utf-8')).hexdigest()
    
    # Attempt to retrieve cached retriever
    retriever = load_retriever_from_hash(content_hash, page_url=page_url)
    if retriever:
        # Update metadata
        try:
            cache_table.update_item(
                Key={'contentHash': content_hash},
                UpdateExpression='SET lastAccessed = :timestamp, #s = :status',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={
                    ':timestamp': int(time.time()),
                    ':status': 'ready'
                },
                ReturnValues='NONE'
            )
        except:
            pass
        return retriever
    
    # Check if build is already IN PROGRESS by another Lambda (e.g. preload)
    try:
        response = cache_table.get_item(
            Key={'contentHash': content_hash},
            ConsistentRead=True
        )
        item = response.get('Item')
        
        if item and item.get('status') == 'processing':
            # Check if processing is stale (older than 2 minutes)
            start_time = item.get('createdAt', 0)
            if int(time.time()) - start_time < 120:
                # Wait for concurrent processing to complete (maximum 30 seconds)
                for _ in range(30):
                    time.sleep(1)
                    if load_retriever_from_hash(content_hash):
                        return load_retriever_from_hash(content_hash)
    except Exception as e:
        pass
    
    # Mark as PROCESSING
    try:
        cache_table.put_item(
            Item={
                'contentHash': content_hash,
                'status': 'processing',
                'createdAt': int(time.time()),
                'ttl': int(time.time()) + 3600
            }
        )
    except:
        pass
    
    # Initialize embeddings model
    embeddings = BedrockEmbeddings(
        client=bedrock_runtime,
        model_id="amazon.titan-embed-text-v2:0",
    )
    
    # Split text into chunks for processing
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1200,
        chunk_overlap=120,
        separators=["\n\n", "\n", ". ", " "],
    )
    chunks = splitter.split_text(page_text)

    # Build FAISS vector store
    vector_store = FAISS.from_texts(chunks, embeddings)
    retriever = vector_store.as_retriever(search_kwargs={"k": 5})
    
    # Cache the FAISS index
    temp_path = f"/tmp/faiss_{content_hash}"
    s3_key = f"embeddings/{content_hash}/index.faiss"
    s3_pkl_key = f"embeddings/{content_hash}/index.pkl"
    
    try:
        os.makedirs(temp_path, exist_ok=True)
        vector_store.save_local(temp_path)
        s3_client.upload_file(f"{temp_path}/index.faiss", CACHE_BUCKET, s3_key)
        s3_client.upload_file(f"{temp_path}/index.pkl", CACHE_BUCKET, s3_pkl_key)
        
        # Verify upload
        s3_client.head_object(Bucket=CACHE_BUCKET, Key=s3_key)
        s3_client.head_object(Bucket=CACHE_BUCKET, Key=s3_pkl_key)
        
        # Save metadata to DynamoDB
        cache_table.put_item(
            Item={
                'contentHash': content_hash,
                'status': 'ready',
                's3Key': s3_key,
                'createdAt': int(time.time()),
                'lastAccessed': int(time.time()),
                'numChunks': len(chunks),
                'ttl': int(time.time()) + (7 * 24 * 60 * 60)
            }
        )
    except Exception as e:
        # Mark as failed in DynamoDB
        try:
            cache_table.put_item(
                Item={
                    'contentHash': content_hash,
                    'status': 'failed',
                    'error': str(e),
                    'createdAt': int(time.time()),
                    'ttl': int(time.time()) + 3600
                }
            )
        except:
            pass
    
    return retriever


# Lambda function entry point
def lambda_handler(event, context):
    # Parse request body from the event
    if isinstance(event.get('body'), str):
        requestBody = json.loads(event['body'])
    elif isinstance(event.get('body'), dict):
        requestBody = event['body']
    else:
        requestBody = event
    
    # Verify authentication token (if provided)
    auth_token = requestBody.get('authToken', '')
    user_id = 'anonymous'  # Default
    user_email = None
    user_first_name = None
    user_last_name = None
    
    if auth_token:
        token_payload = verify_cognito_token(auth_token)
        if token_payload:
            # Extract user info from token
            user_id = token_payload.get('sub')  # Cognito user ID (unique)
            user_email = token_payload.get('email')
            user_first_name = token_payload.get('given_name')
            user_last_name = token_payload.get('family_name')
        else:
            # Invalid token
            return {
                'statusCode': 401,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                'body': json.dumps({'error': 'Invalid or expired authentication token'})
            }
    
    timestamp = int(time.time() * 1000)
    action = requestBody.get('action', '')
    session_id = requestBody.get('session_id', str(uuid.uuid4()))

    # Handle deletion request
    if action == 'delete':
        result = delete_chat_history(session_id, user_id)
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': json.dumps({
                'message': result
            })
        }
    
    # Handle list sessions request
    elif action == 'listSessions':
        result = list_chat_sessions(user_id)
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': json.dumps(result, default=decimal_to_int)
        }
    
    # Handle get session history request
    elif action == 'getSession':
        session_id = requestBody.get('session_id')
        result = get_session_history(session_id, user_id)
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': json.dumps(result, default=decimal_to_int)
        }
    
    # Handle create new session request
    elif action == 'createSession':
        new_session_id = str(uuid.uuid4())
        pageURL = requestBody.get('pageURL', '')
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': json.dumps({
                'session_id': new_session_id,
                'pageURL': pageURL,
                'createdAt': timestamp
            })
        }
    
    # Handle preload embeddings request for proactive caching
    elif action == 'preloadEmbeddings':
        pageContent = requestBody.get('pageContent', '')
        pageURL = requestBody.get('pageURL', '')
        
        try:
            # Decode page content JSON and extract text
            if isinstance(pageContent, str):
                page_data = json.loads(pageContent)
            else:
                page_data = pageContent
            page_text = page_data.get('text', '')
            
            if not page_text:
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS'
                    },
                    'body': json.dumps({'status': 'skipped', 'reason': 'no_content'})
                }
            
            # Build and cache retriever for page embeddings
            retriever = build_page_retriever(page_text, page_url=pageURL)
            
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                'body': json.dumps({
                    'status': 'success'
                })
            }
        except Exception as e:
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                'body': json.dumps({'status': 'error', 'message': str(e)})
            }

    # Handle user query (ask action)
    elif action == 'ask':
        ImageURL = requestBody.get('imageContext', '')
        pageContent = requestBody['pageContent']
        prompt = requestBody['prompt']
        pageURL = requestBody['pageURL']
        
        # Extract first valid image from multiple image URLs
        if ImageURL and '\n' in ImageURL:
            image_urls = [url.strip() for url in ImageURL.split('\n') if url.strip()]
            ImageURL = image_urls[0] if image_urls else ''

        try:
            # Retrieve conversation history for contextual processing
            previous_messages = []
            session_pages = {}
            
            try:
                session_history_response = get_session_conversation_history(session_id, user_id, limit=100)
                previous_messages = session_history_response.get('messages', [])
                session_pages = session_history_response.get('pages', {})
            except Exception as hist_err:
                pass
            
            # Decode page content JSON and extract text
            if isinstance(pageContent, str):
                page_data = json.loads(pageContent)
            else:
                page_data = pageContent
            page_text = page_data.get('text', '')

            # Generate content hash for session tracking and caching
            content_hash = hashlib.sha256(page_text.encode('utf-8')).hexdigest()
            
            # Add current page to session pages
            session_pages[pageURL] = {
                'text': page_text,
                'contentHash': content_hash
            }
            
            # Multi-page Retrieval Strategy:
            # 1. Build current page retriever first
            current_retriever = build_page_retriever(page_text, page_url=pageURL)
            
            # 2. Load previous page retrievers from cache
            previous_retrievers = []
            for url, data in session_pages.items():
                if url == pageURL:
                    continue  # Skip current page
                
                prev_hash = data.get('contentHash')
                if prev_hash:
                    r = load_retriever_from_hash(prev_hash, page_url=url)
                    if r:
                        previous_retrievers.append(r)
            
            # 3. Combine retrievers with current page as last element
            retriever = previous_retrievers + [current_retriever]
                
            # Prepare pages content for contextual prompt construction
            pages_with_content = session_pages

            # Prepare image for multimodal input
            image_data_base64 = None
            image_media_type = None
            if ImageURL and ImageURL.strip():
                try:
                    # Configure HTTP headers to prevent access restrictions
                    headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': pageURL
                    }
                    response = requests.get(ImageURL, timeout=10, headers=headers)
                    response.raise_for_status()
                    imageData = response.content
                    
                    image = Image.open(io.BytesIO(imageData))
                    width, height = image.size
                    img_format = image.format

                    # Optimize image dimensions for vision model processing
                    max_dimension = 512
                    if max(width, height) > max_dimension:
                        scaling_factor = max_dimension / max(width, height)
                        new_width = int(width * scaling_factor)
                        new_height = int(height * scaling_factor)

                        image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
                        # Compress image to JPEG format for efficient processing
                        buf = io.BytesIO()
                        if img_format == 'PNG' and image.mode == 'RGBA':
                            # Convert RGBA to RGB for JPEG compatibility
                            background = Image.new('RGB', image.size, (255, 255, 255))
                            background.paste(image, mask=image.split()[3])
                            background.save(buf, format='JPEG', quality=75)
                        else:
                            image.convert('RGB').save(buf, format='JPEG', quality=75)
                        buf.seek(0)
                        imageData = buf.getvalue()
                        img_format = 'JPEG'
                    else:
                        # Even if not resizing, still convert to JPEG for consistency
                        buf = io.BytesIO()
                        if img_format == 'PNG' and image.mode == 'RGBA':
                            background = Image.new('RGB', image.size, (255, 255, 255))
                            background.paste(image, mask=image.split()[3])
                            background.save(buf, format='JPEG', quality=75)
                        else:
                            image.convert('RGB').save(buf, format='JPEG', quality=75)
                        buf.seek(0)
                        imageData = buf.getvalue()
                        img_format = 'JPEG'

                    # Convert to base64 for Bedrock
                    image_data_base64 = base64.b64encode(imageData).decode('utf-8')
                    
                    # Map format to media type
                    format_map = {
                        'jpeg': 'image/jpeg',
                        'jpg': 'image/jpeg',
                        'png': 'image/png',
                        'gif': 'image/gif',
                        'webp': 'image/webp'
                    }
                    img_format_lower = (img_format or 'jpeg').lower()
                    image_media_type = format_map.get(img_format_lower, 'image/jpeg')
                except Exception as img_err:
                    import traceback

            # Initialize LLM and tools
            llm = make_bedrock_llm()
            
            # Handle image questions differently - call LLM directly with vision
            if image_data_base64:
                # Use Bedrock Converse API directly for Llama vision
                try:
                    # Decode base64 to bytes for Converse API
                    image_bytes = base64.b64decode(image_data_base64)
                    response = bedrock_runtime.converse(
                        modelId=MODEL_ID,
                        messages=[
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "image": {
                                            "format": "jpeg",
                                            "source": {
                                                "bytes": image_bytes
                                            }
                                        }
                                    },
                                    {
                                        "text": prompt
                                    }
                                ]
                            }
                        ],
                        inferenceConfig={
                            "temperature": 0.2,
                            "maxTokens": 1024
                        }
                    )
                    
                    generated_text = response['output']['message']['content'][0]['text']
                except Exception as e:
                    import traceback
                    # Provide error message if image analysis fails
                    generated_text = f"I was able to fetch the image, but encountered an error analyzing it: {str(e)}"
                
            else:
                # Process text query using direct retrieval-augmented generation
                
                # Construct conversation history context
                conversation_context = ""
                if previous_messages:
                    conversation_context = "\n\nCONVERSATION HISTORY (Last messages):\n"
                    for msg in previous_messages[-100:]:  # Last 100 for context window
                        conversation_context += f"User: {msg.get('question', '')}\n"
                        conversation_context += f"You: {msg.get('answer', '')}\n"
                    conversation_context += "\n"
                
                # Build pages context with numbering
                pages_context = ""
                if len(pages_with_content) > 1:
                    pages_context = f"\n\nIMPORTANT - BROWSING SESSION CONTEXT:\n"
                    pages_context += f"The user is browsing through multiple pages in this session. You have access to content from ALL pages visited (in order):\n"
                    for idx, url in enumerate(pages_with_content.keys(), 1):
                        if url == pageURL:
                            pages_context += f"{idx}. {url} ← CURRENT PAGE\n"
                        else:
                            pages_context += f"{idx}. {url}\n"
                    pages_context += f"\nWhen user says 'previous page' or 'previous one', they mean the page that came BEFORE the current page in this numbered list.\n"
                
                # Build user context
                user_context = ""
                if user_first_name and user_last_name:
                    user_context = f"\n\nUSER INFORMATION:\nYou are talking to {user_first_name} {user_last_name}.\n"
                
                # Retrieve relevant content from current and previous pages
                all_docs = []
                
                if retriever:
                    # Extract and tag content from current page
                    current_retriever = retriever[-1]
                    if current_retriever:
                        try:
                            current_retriever.search_kwargs = {"k": 5}
                            docs = current_retriever.invoke(prompt)
                            for doc in docs:
                                doc.metadata['page_priority'] = 'current'
                            all_docs.extend(docs)
                        except Exception as e:
                            pass
                    
                    # Extract and tag content from previous pages
                    for idx, prev_retriever in enumerate(retriever[:-1]):
                        if prev_retriever:
                            try:
                                prev_retriever.search_kwargs = {"k": 5}
                                docs = prev_retriever.invoke(prompt)
                                for doc in docs:
                                    doc.metadata['page_priority'] = 'previous'
                                all_docs.extend(docs)
                            except Exception as e:
                                pass
                
                # Deduplicate by content
                seen = set()
                unique_docs = []
                for d in all_docs:
                    content = d.page_content.strip()
                    if content and content not in seen:
                        seen.add(content)
                        unique_docs.append(d)
                
                # Organize retrieved content by page priority
                current_chunks = [d for d in unique_docs if d.metadata.get('page_priority') == 'current']
                previous_chunks = [d for d in unique_docs if d.metadata.get('page_priority') == 'previous']
                
                # Construct structured context for model input
                retrieved_content = ""
                if current_chunks:
                    retrieved_content += "=== CURRENT PAGE CONTENT ===\n"
                    retrieved_content += "\n---\n".join(d.page_content for d in current_chunks[:15])
                    retrieved_content += "\n\n"
                
                if previous_chunks:
                    retrieved_content += "=== PREVIOUS PAGES CONTENT (for context) ===\n"
                    retrieved_content += "\n---\n".join(d.page_content for d in previous_chunks[:15])
                
                if not retrieved_content:
                    retrieved_content = "No relevant page content found."
                
                # Generate AI response using retrieved context
                message_content = (
                    f"You are QuickPage, a friendly and helpful AI assistant that helps users understand web pages.\n\n"
                    f"ABOUT YOURSELF:\n"
                    f"- Your name is QuickPage\n"
                    f"- You're a browser extension that helps users quickly understand web page content\n"
                    f"- You can read any web page, answer questions about it, and provide insights\n"
                    f"- You remember the conversation history and all pages visited in this session\n\n"
                    f"{user_context}"
                    f"{conversation_context}"
                    f"CURRENT BROWSING SESSION:\n"
                    f"Currently viewing: {pageURL}\n"
                    f"{pages_context}"
                    f"\n=== RELEVANT PAGE CONTENT ===\n"
                    f"(Content is organized with CURRENT page first, then PREVIOUS pages for context)\n\n"
                    f"{retrieved_content}\n"
                    f"=== END OF PAGE CONTENT ===\n\n"
                    f"IMPORTANT INSTRUCTIONS:\n"
                    f"1. Content above is clearly marked as 'CURRENT PAGE' vs 'PREVIOUS PAGES'.\n"
                    f"2. Naturally understand what the user is asking about - it could be about the current page or previous pages. If the question is vague, consider it about the current page.\n"
                    f"3. Answer questions in a NATURAL, CONVERSATIONAL way - like a helpful friend, not a formal analyst.\n"
                    f"4. AVOID formal phrases like 'According to my analysis...', 'Based on my findings...', etc. Just answer directly!\n"
                    f"5. CONVERSATION FLOW - CRITICAL RULES:\n"
                    f"   - USE the conversation history to understand what the user is talking about. User questions almost always depend on previous questions and answers.\n"
                    f"   - The user is continuing the conversation - understand context from their previous messages to know what they're referring to.\n"
                    f"   - DO NOT explain what they're doing. DO NOT say 'It seems like...', 'You're acknowledging...', 'Would you like to know more...', 'you asked this earlier', 'as I mentioned'.\n"
                    f"   - Just answer naturally, incorporating the context from previous messages without explicitly mentioning the conversation itself.\n"
                    f"   - Example: If user asks 'what is the area of Texas?' then 'compare it with Florida', understand they mean compare Texas with Florida.\n"
                    f"6. Only if information is NOT found in the page content, then you may use general knowledge and state: "
                    f"'This information isn't available on the pages you've visited, but [your answer]'\n"
                    f"7. Be confident and direct - just give the answer naturally!\n\n"
                    f"User question: {prompt}"
                )
                
                response = llm.invoke(message_content)
                generated_text = response.content

            # Persist conversation data to DynamoDB
            session_title = prompt[:50] + ('...' if len(prompt) > 50 else '')
            
            # Determine if this is the initial message in the session
            try:
                existing = table.query(
                    KeyConditionExpression=Key('sessionid').eq(session_id),
                    Limit=1
                )
                is_first_message = len(existing.get('Items', [])) == 0
            except:
                is_first_message = True
            
            item = {
                'sessionid': session_id,
                'timestamp': timestamp,
                'userId': user_id,
                'question': prompt,
                'answer': generated_text,
                'ImageURL': ImageURL,
                'pageURL': pageURL,
                'pageContent': pageContent,
                'contentHash': content_hash,
                'lastMessageAt': timestamp
            }
            
            # Initialize session metadata for new conversations
            if is_first_message:
                item['sessionTitle'] = session_title
                item['createdAt'] = timestamp
            
            table.put_item(Item=item)

            # Construct and return the response to the client
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                'body': json.dumps({
                    'prompt': prompt,
                    'response': generated_text
                })
            }
        except Exception as e:
            # Handle errors
            return {
                'statusCode': 500,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                'body': json.dumps({
                    'error': str(e)
                })
            }

# Function to delete chat history from DynamoDB
def delete_chat_history(session_id, user_id):
    try:
        # Query for items with the given session_id
        response = table.query(
            KeyConditionExpression=Key('sessionid').eq(session_id)
        )
        items = response['Items']
        
        # Filter by userId in Python
        if user_id and user_id != 'anonymous':
            items = [item for item in items if item.get('userId') == user_id]

        # Delete each item in the chat history
        with table.batch_writer() as batch:
            for item in items:
                batch.delete_item(
                    Key={
                        'sessionid': item['sessionid'],
                        'timestamp': item['timestamp']
                    }
                )
        return f"Deleted {len(items)} items for session {session_id}."
    except Exception as e:
        return f"Error deleting items: {str(e)}"


# Function to list all chat sessions
def list_chat_sessions(user_id):
    """Get list of all chat sessions for a specific user."""
    try:
        # Scan table to get all sessions with pagination
        items = []
        response = table.scan()
        items.extend(response['Items'])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response['Items'])
        
        # Filter by userId in Python (simpler than DynamoDB FilterExpression)
        if user_id and user_id != 'anonymous':
            items = [item for item in items if item.get('userId') == user_id]
        
        # Group by session_id and get session metadata
        sessions = {}
        for item in items:
            sid = item.get('sessionid')
            if not sid:
                continue
                
            if sid not in sessions:
                # Get title from sessionTitle field or first question
                title = item.get('sessionTitle', '')
                if not title:
                    title = item.get('question', 'Untitled Chat')
                if len(title) > 50:
                    title = title[:50] + '...'
                    
                sessions[sid] = {
                    'session_id': sid,
                    'sessionTitle': title,
                    'pageURL': item.get('pageURL', ''),
                    'contentHash': item.get('contentHash', ''),
                    'createdAt': item.get('createdAt', item.get('timestamp', 0)),
                    'lastMessageAt': item.get('timestamp', 0),
                    'messageCount': 0
                }
            
            # Update last message time and count
            sessions[sid]['lastMessageAt'] = max(
                sessions[sid]['lastMessageAt'],
                item.get('timestamp', 0)
            )
            sessions[sid]['messageCount'] += 1
            
            # Update session title if this item has it
            if item.get('sessionTitle'):
                sessions[sid]['sessionTitle'] = item['sessionTitle']
            
            # Update createdAt if this item has it
            if item.get('createdAt'):
                sessions[sid]['createdAt'] = item['createdAt']
        
        # Convert to list and sort by last message time (newest first)
        session_list = list(sessions.values())
        session_list.sort(key=lambda x: x.get('lastMessageAt', 0), reverse=True)
        
        return {'sessions': session_list}
    except Exception as e:
        import traceback
        return {'sessions': [], 'error': str(e)}


# Function to get session history
def get_session_history(session_id, user_id):
    """Get all messages for a specific session owned by user."""
    try:
        response = table.query(
            KeyConditionExpression=Key('sessionid').eq(session_id),
            ScanIndexForward=True  # Sort by timestamp ascending (oldest first)
        )
        
        items = response['Items']
        
        # Filter by userId in Python
        if user_id and user_id != 'anonymous':
            items = [item for item in items if item.get('userId') == user_id]
        
        messages = []
        session_metadata = {}
        
        for item in items:
            messages.append({
                'question': item.get('question', ''),
                'answer': item.get('answer', ''),
                'timestamp': item.get('timestamp'),
                'ImageURL': item.get('ImageURL', '')
            })
            
            # Get session metadata from first message
            if not session_metadata:
                session_metadata = {
                    'session_id': session_id,
                    'sessionTitle': item.get('sessionTitle', item.get('question', 'Untitled Chat')[:50]),
                    'pageURL': item.get('pageURL', ''),
                    'contentHash': item.get('contentHash', ''),
                    'pageContent': item.get('pageContent', ''),
                    'createdAt': item.get('createdAt', item.get('timestamp'))
                }
        
        return {
            'session': session_metadata,
            'messages': messages
        }
    except Exception as e:
        return {'session': {}, 'messages': [], 'error': str(e)}

def get_session_conversation_history(session_id, user_id, limit=100):
    """Get conversation history and all pages visited in this session."""
    try:
        response = table.query(
            KeyConditionExpression=Key('sessionid').eq(session_id),
            ScanIndexForward=False,  # Most recent first
            Limit=limit
        )
        
        items = response['Items']
        
        # Filter by userId in Python
        if user_id and user_id != 'anonymous':
            items = [item for item in items if item.get('userId') == user_id]
        
        # Reverse to get chronological order
        items.reverse()
        
        messages = []
        pages = {}  # Dictionary of pageURL -> {text, contentHash}
        
        for item in items:
            messages.append({
                'question': item.get('question', ''),
                'answer': item.get('answer', ''),
                'timestamp': item.get('timestamp'),
                'pageURL': item.get('pageURL', '')
            })
            
            # Collect unique pages - but DON'T load pageContent from history!
            # This was loading massive amounts of data unnecessarily
            page_url = item.get('pageURL', '')
            if page_url and page_url not in pages:
                pages[page_url] = {
                    'text': '',  # Empty - we'll only use current page
                    'contentHash': item.get('contentHash', '')
                }
        
        return {
            'messages': messages,
            'pages': pages
        }
    except Exception as e:
        return {'messages': [], 'pages': {}}
