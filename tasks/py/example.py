import os

def process_data(message):
    print(f"Python received: {message}")
    
    # Example logic: list files in the directory
    files = os.listdir('.')
    print(f"I see these files: {files}")
    
    # You can also set variables to be used by later Digdag tasks
    # (Requires digging into the 'digdag' python library if needed)