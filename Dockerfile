FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Where persistent state (seen.json etc.) is written; mount a volume here
ENV DATA_DIR=/data
RUN mkdir -p /data

# Unbuffered output so logs show up live in Coolify
ENV PYTHONUNBUFFERED=1

CMD ["python", "monitor.py"]
