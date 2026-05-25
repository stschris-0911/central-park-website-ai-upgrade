FROM node:20-bullseye AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS backend-runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY backend/requirements.txt /app/backend/requirements.txt
COPY backend/requirements-vision.txt /app/backend/requirements-vision.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
ARG INSTALL_VISION_RUNTIME=0
RUN if [ "$INSTALL_VISION_RUNTIME" = "1" ]; then pip install --no-cache-dir -r /app/backend/requirements-vision.txt; fi

COPY backend /app/backend
COPY data /app/data
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
