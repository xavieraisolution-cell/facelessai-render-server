# FacelessAI Render Server

Servidor FFmpeg para renderização de vídeos do workflow FacelessAI.

## Deploy no Render.com

1. Crie um novo repositório no GitHub chamado `facelessai-render-server`
2. Faça upload de todos esses arquivos
3. No Render.com, crie um novo **Web Service**
4. Conecte o repositório GitHub
5. Configure:
   - **Environment**: Docker
   - **Plan**: Starter ($7/mês) ou Free
   - **Environment Variables**:
     - `AUTH_KEY` = `facelessai2026xaviersecretkey32x`
     - `PORT` = `3000`

## Endpoints

- `GET /` — Health check
- `POST /render` — Renderiza vídeo

## Headers obrigatórios

```
Authorization: Bearer facelessai2026xaviersecretkey32x
Content-Type: application/json
```

## Body do /render

```json
{
  "job_id": "job_123",
  "audio_url": "https://...",
  "clips": [{"url": "https://..."}, ...],
  "subtitle_text": "Texto do roteiro",
  "output_resolution": "1920x1080",
  "thumbnail_text": "Título do vídeo"
}
```
