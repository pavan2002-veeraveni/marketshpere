import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    python_service_port: int = int(os.getenv("PYTHON_SERVICE_PORT", "8000"))
    internal_service_token: str = os.getenv(
        "INTERNAL_SERVICE_TOKEN", "marketsphere_local_internal_service_token"
    )
    default_tax_rate: str = os.getenv("DEFAULT_TAX_RATE", "0.0825")
    default_currency: str = os.getenv("DEFAULT_CURRENCY", "USD")
    free_shipping_threshold: str = os.getenv("FREE_SHIPPING_THRESHOLD", "150.00")
    flat_shipping_fee: str = os.getenv("FLAT_SHIPPING_FEE", "9.99")
    log_level: str = os.getenv("LOG_LEVEL", "info")


settings = Settings()
