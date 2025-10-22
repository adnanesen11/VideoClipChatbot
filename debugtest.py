#!/usr/bin/env python3
"""
Simple script to test Bedrock Agent with trace enabled and save all output to a file.
"""

import boto3
import json
import os
from datetime import datetime
from botocore.exceptions import ClientError

# Configuration - Update these with your values
AGENT_ID = "FGNOXYIOTJ"  # Your agent ID
AGENT_ALIAS_ID = "G8NSOVMJFY"  # Your agent alias ID
AWS_REGION = "us-east-1"  # Your AWS region

# Example question to test with
EXAMPLE_QUESTION = "How should I group similar documents?"

def generate_session_id():
    """Generate a unique session ID."""
    timestamp = int(datetime.now().timestamp() * 1000)
    return f"session-{timestamp}-python-test"

def main():
    try:
        # Initialize the Bedrock Agent Runtime client
        client = boto3.client(
            'bedrock-agent-runtime',
            region_name=AWS_REGION
        )
        
        print(f"Testing Bedrock Agent: {AGENT_ID}")
        print(f"Agent Alias: {AGENT_ALIAS_ID}")
        print(f"Question: {EXAMPLE_QUESTION}")
        print("-" * 50)
        
        # Invoke the agent with trace enabled
        response = client.invoke_agent(
            agentId=AGENT_ID,
            agentAliasId=AGENT_ALIAS_ID,
            sessionId=generate_session_id(),
            inputText=EXAMPLE_QUESTION,
            enableTrace=True  # This is the key - enables tracing
        )
        
        # Collect all response data
        agent_response = ""
        all_events = []
        trace_count = 0
        
        print("Processing response stream...")
        
        # Process the streaming response
        for event in response['completion']:
            # Store the entire event for debugging
            all_events.append(event)
            
            # Extract text chunks
            if 'chunk' in event and 'bytes' in event['chunk']:
                chunk_text = event['chunk']['bytes'].decode('utf-8')
                agent_response += chunk_text
                print(f"[CHUNK] {chunk_text}")
            
            # Extract trace information
            if 'trace' in event:
                trace_count += 1
                print(f"[TRACE {trace_count}] Found trace event")
                
                # Print trace type and key info
                trace = event['trace']
                if 'orchestrationTrace' in trace:
                    orch_trace = trace['orchestrationTrace']
                    if 'observation' in orch_trace:
                        obs_type = orch_trace['observation'].get('type', 'unknown')
                        print(f"  -> Observation type: {obs_type}")
                    if 'modelInvocationInput' in orch_trace:
                        print(f"  -> Has model invocation input")
                    if 'modelInvocationOutput' in orch_trace:
                        print(f"  -> Has model invocation output")
        
        # Prepare output data
        output_data = {
            "timestamp": datetime.now().isoformat(),
            "agent_id": AGENT_ID,
            "agent_alias_id": AGENT_ALIAS_ID,
            "question": EXAMPLE_QUESTION,
            "agent_response": agent_response,
            "trace_count": trace_count,
            "all_events": all_events
        }
        
        # Generate filename with timestamp
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"bedrock_agent_trace_{timestamp_str}.txt"
        
        # Save to file
        with open(filename, 'w', encoding='utf-8') as f:
            f.write("BEDROCK AGENT TRACE OUTPUT\n")
            f.write("=" * 50 + "\n")
            f.write(f"Timestamp: {output_data['timestamp']}\n")
            f.write(f"Agent ID: {AGENT_ID}\n")
            f.write(f"Agent Alias ID: {AGENT_ALIAS_ID}\n")
            f.write(f"Question: {EXAMPLE_QUESTION}\n")
            f.write(f"Trace Events Found: {trace_count}\n")
            f.write("\n" + "=" * 50 + "\n")
            f.write("AGENT RESPONSE:\n")
            f.write("-" * 20 + "\n")
            f.write(agent_response)
            f.write("\n\n" + "=" * 50 + "\n")
            f.write("COMPLETE RAW DATA (JSON):\n")
            f.write("-" * 30 + "\n")
            f.write(json.dumps(output_data, indent=2, default=str))
        
        print(f"\n✅ SUCCESS!")
        print(f"Agent Response: {agent_response[:200]}...")
        print(f"Trace events found: {trace_count}")
        print(f"Output saved to: {filename}")
        
    except ClientError as e:
        error_code = e.response['Error']['Code']
        error_message = e.response['Error']['Message']
        print(f"❌ AWS Error ({error_code}): {error_message}")
        
        # Save error to file as well
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"bedrock_agent_error_{timestamp_str}.txt"
        
        with open(filename, 'w') as f:
            f.write(f"BEDROCK AGENT ERROR\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")
            f.write(f"Error Code: {error_code}\n")
            f.write(f"Error Message: {error_message}\n")
            f.write(f"Full Error: {str(e)}\n")
        
        print(f"Error details saved to: {filename}")
        
    except Exception as e:
        print(f"❌ Unexpected error: {str(e)}")
        
        # Save error to file
        timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"bedrock_agent_exception_{timestamp_str}.txt"
        
        with open(filename, 'w') as f:
            f.write(f"BEDROCK AGENT EXCEPTION\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")
            f.write(f"Exception: {str(e)}\n")
            f.write(f"Type: {type(e).__name__}\n")
        
        print(f"Exception details saved to: {filename}")

if __name__ == "__main__":
    # Check if AWS credentials are configured
    try:
        session = boto3.Session()
        credentials = session.get_credentials()
        if credentials is None:
            print("❌ AWS credentials not found!")
            print("Make sure you have:")
            print("1. AWS_ACCESS_KEY_ID environment variable")
            print("2. AWS_SECRET_ACCESS_KEY environment variable") 
            print("3. Or AWS credentials file configured")
            print("4. Or IAM role attached to your instance")
            exit(1)
        else:
            print(f"✅ AWS credentials found for region: {AWS_REGION}")
    except Exception as e:
        print(f"❌ Error checking AWS credentials: {e}")
        exit(1)
    
    main()
