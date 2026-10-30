"""게이트웨이 앱 조립. 실행: uvicorn app.main:app --port 8000"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.clientip import public_guard
from app.contract import PUBLIC_MODE
from app.db import init_db
from app.detector.router import router as detector_router, worker_loop
from app.gateway.router import router as gateway_router
from app.testpage import router as test_router
from app.usage import router as usage_router
from app.wif_inbound import router as wif_router


@asynccontextmanager
async def lifespan(_):
    init_db()
    task = asyncio.create_task(worker_loop())
    yield
    task.cancel()


_docs = {"docs_url": None, "redoc_url": None, "openapi_url": None} if PUBLIC_MODE else {}
app = FastAPI(title="NovemberAiGateway", lifespan=lifespan, **_docs)
app.middleware("http")(public_guard)  # CORS보다 안쪽(먼저 등록)이라 401에도 CORS 헤더가 붙는다
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(gateway_router)
app.include_router(detector_router)
app.include_router(usage_router)
app.include_router(wif_router)
app.include_router(test_router)


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(Path(__file__).parent / "static" / "home.html")


app.mount("/ui", StaticFiles(directory=Path(__file__).parent / "static" / "ui", html=True), name="ui")  # 웹 화면(ntrophy-gateway 프런트)
