import uuid

from fastapi import FastAPI, Request

from app.api.v1.router import router as v1_router

app = FastAPI(
    title="MarketSphere Python Calculation & Intelligence Service",
    version="1.0.0",
    description="Deterministic pricing, promotions, commission math, catalog feed normalization, and explainable recommendations.",
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or f"py_{uuid.uuid4()}"
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


app.include_router(v1_router, prefix="/api/v1")
