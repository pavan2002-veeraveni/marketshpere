import hmac
from typing import Annotated

from fastapi import Header, HTTPException, status

from app.core.config import settings


def verify_internal_token(
    x_internal_service_token: Annotated[str | None, Header()] = None,
) -> None:
    if not x_internal_service_token or not hmac.compare_digest(
        x_internal_service_token, settings.internal_service_token
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal service token",
        )
