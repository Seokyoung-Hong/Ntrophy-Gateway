"""사용량 집계·예측(/admin/usage/*). 계약: docs/contract.md H. status_code 200만 집계."""
import calendar
import time
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.db import get_conn
from app.gateway.router import _admin, iso
from app.pricing import estimate_cost_krw, price_of

router = APIRouter(prefix="/admin/usage", dependencies=[Depends(_admin)])
Range = Literal["day", "week", "month", "all"]


def _start(rng: str, now: float) -> float:
    d = datetime.fromtimestamp(now)  # 서버 로컬 시간 기준
    if rng == "day":
        return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    if rng == "week":
        return now - 7 * 86400  # 최근 7일
    if rng == "month":
        return d.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    return 0.0


def _budget():
    with get_conn() as c:
        r = c.execute("SELECT value FROM setting WHERE key='monthly_budget_krw'").fetchone()
    return int(r[0]) if r else None


def _zero():
    return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_krw": 0.0, "estimated_cost_krw": 0.0}


def _add(acc, row, est):
    acc["calls"] += row["calls"]
    acc["input_tokens"] += row["inp"]
    acc["output_tokens"] += row["outp"]
    acc["cost_krw"] = round(acc["cost_krw"] + row["cost"], 4)
    acc["estimated_cost_krw"] = round(acc["estimated_cost_krw"] + est, 4)


@router.get("/summary")
def summary(range: Range = "day"):
    now = time.time()
    since = _start(range, now)
    with get_conn() as c:
        rows = c.execute(
            "SELECT u.service_id sid, s.name, u.model, COUNT(*) calls, COALESCE(SUM(u.input_tokens),0) inp,"
            " COALESCE(SUM(u.output_tokens),0) outp, SUM(u.cost_krw) cost FROM usage_log u"
            " LEFT JOIN service s ON s.id=u.service_id WHERE u.status_code=200 AND u.at>=?"
            " GROUP BY u.service_id, u.model ORDER BY u.service_id, u.model", (since,)).fetchall()
    total, services = _zero(), {}
    for r in rows:
        est = estimate_cost_krw(r["model"], r["inp"], r["outp"])  # 단가가 선형이라 합계에 곱해도 같다
        svc = services.setdefault(r["sid"], {"service_id": r["sid"], "name": r["name"], **_zero(), "models": []})
        m = {"model": r["model"], **_zero(), "estimated": price_of(r["model"])[1]}
        for acc in (total, svc, m):
            _add(acc, r, est)
        svc["models"].append(m)
    return {"range": range, "from": iso(since), "to": iso(now), "total": total, "services": list(services.values())}


@router.get("/timeseries")
def timeseries(range: Range = "day", bucket: Literal["hour", "day"] = "hour"):
    now = time.time()
    since = _start(range, now)
    fmt = "%Y-%m-%dT%H:00" if bucket == "hour" else "%Y-%m-%d"
    with get_conn() as c:
        rows = c.execute(
            "SELECT u.service_id sid, s.name, strftime(?, u.at, 'unixepoch', 'localtime') t, COUNT(*) calls,"
            " COALESCE(SUM(u.input_tokens),0)+COALESCE(SUM(u.output_tokens),0) tokens, SUM(u.cost_krw) cost"
            " FROM usage_log u LEFT JOIN service s ON s.id=u.service_id WHERE u.status_code=200 AND u.at>=?"
            " GROUP BY u.service_id, t ORDER BY u.service_id, t", (fmt, since)).fetchall()
    services = {}
    for r in rows:
        svc = services.setdefault(r["sid"], {"service_id": r["sid"], "name": r["name"], "points": []})
        svc["points"].append({"t": r["t"], "calls": r["calls"], "tokens": r["tokens"], "cost_krw": round(r["cost"], 4)})
    return {"range": range, "bucket": bucket, "from": iso(since), "to": iso(now), "services": list(services.values())}


@router.get("/forecast")
def forecast(window_hours: float = Query(1, gt=0, le=24 * 31)):
    now = time.time()
    d = datetime.fromtimestamp(now)
    day0, month0 = _start("day", now), _start("month", now)
    month_end = d.replace(day=calendar.monthrange(d.year, d.month)[1], hour=0, minute=0, second=0,
                          microsecond=0).timestamp() + 86400
    q = ("SELECT u.service_id sid, s.name, COUNT(*) calls,"
         " COALESCE(SUM(u.input_tokens),0)+COALESCE(SUM(u.output_tokens),0) tokens, COALESCE(SUM(u.cost_krw),0) cost"
         " FROM usage_log u LEFT JOIN service s ON s.id=u.service_id WHERE u.status_code=200 AND u.at>=?")
    with get_conn() as c:
        win = c.execute(q + " GROUP BY u.service_id", (now - window_hours * 3600,)).fetchall()
        today = c.execute(q, (day0,)).fetchone()["cost"]
        month_rows = {r["sid"]: r["cost"] for r in c.execute(q + " GROUP BY u.service_id", (month0,))}
    month = sum(month_rows.values())
    rate = {"calls": sum(r["calls"] for r in win) / window_hours, "tokens": sum(r["tokens"] for r in win) / window_hours,
            "cost_krw": sum(r["cost"] for r in win) / window_hours}
    left_month_h = (month_end - now) / 3600
    budget = _budget()
    hours_to_budget = None
    if budget is not None and rate["cost_krw"] > 0:
        hours_to_budget = round(max(0.0, (budget - month) / rate["cost_krw"]), 2)
    return {
        "window_hours": window_hours,
        "rate_per_hour": {k: round(v, 4) for k, v in rate.items()},
        "projected": {"end_of_day_cost_krw": round(today + rate["cost_krw"] * (day0 + 86400 - now) / 3600, 2),
                      "end_of_month_cost_krw": round(month + rate["cost_krw"] * left_month_h, 2)},
        "per_service": [{"service_id": r["sid"], "name": r["name"],
                         "rate_cost_krw_per_hour": round(r["cost"] / window_hours, 4),
                         "projected_month_cost_krw": round(month_rows.get(r["sid"], 0) + r["cost"] / window_hours * left_month_h, 2)}
                        for r in win],
        "budget": {"monthly_budget_krw": budget, "hours_to_budget": hours_to_budget},
        "method": "linear",
        "note": "최근 window_hours의 시간당 속도가 남은 기간 내내 유지된다고 가정한 단순 선형 추정. "
                "업무시간·요일 패턴, 급증·공격 트래픽, 공급자 가격 변경을 반영하지 않으며 창이 짧을수록 변동이 크다. "
                "per_service는 창 안에 호출이 있는 서비스만 포함.",
    }


class BudgetIn(BaseModel):
    monthly_budget_krw: Optional[int] = None


@router.get("/budget")
def get_budget():
    return {"monthly_budget_krw": _budget()}


@router.put("/budget")
def put_budget(b: BudgetIn):
    v = b.monthly_budget_krw
    if v is not None and v <= 0:
        raise HTTPException(400, "monthly_budget_krw must be > 0 or null")
    with get_conn() as c:
        if v is None:
            c.execute("DELETE FROM setting WHERE key='monthly_budget_krw'")
        else:
            c.execute("INSERT OR REPLACE INTO setting(key,value) VALUES('monthly_budget_krw',?)", (str(v),))
    return get_budget()
