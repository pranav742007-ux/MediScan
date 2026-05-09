# MediScan Production Dockerfile
# Optimized for Render deployment

FROM python:3.11-slim

# Install system dependencies required by pyzbar and opencv
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzbar0 \
    libgl1-mesa-glx \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy requirements first for Docker layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all project files
COPY . .

# Remove development files that shouldn't be in the image
RUN rm -f .env git list_models.py && rm -rf .venv __pycache__ tests .git

# Create instance directory for SQLite fallback
RUN mkdir -p instance

# Expose port (Render sets PORT dynamically)
EXPOSE 5000

# Health check for Render
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT:-5000}/health || exit 1

# Start gunicorn, binding to Render's dynamic $PORT
CMD gunicorn app:app \
    --workers 2 \
    --threads 4 \
    --worker-class gthread \
    --timeout 120 \
    --bind 0.0.0.0:${PORT:-5000} \
    --access-logfile - \
    --error-logfile -
