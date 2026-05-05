# Use a lightweight Python base image
FROM python:3.11-slim

# Install the system library required by pyzbar
RUN apt-get update && apt-get install -y \
    libzbar0 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy your requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all your project files (app.py, instance/, templates, etc.)
COPY . .

# Expose the port Gunicorn will run on
EXPOSE 5000

# Start the server (this replaces the need for your Procfile)
CMD ["gunicorn", "app:app", "--workers", "1", "--timeout", "120", "--bind", "0.0.0.0:5000"]
