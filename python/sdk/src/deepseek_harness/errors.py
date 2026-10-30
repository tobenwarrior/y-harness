"""Compatibility imports for the pre-rebrand SDK errors module."""

from yharness.errors import HarnessError, JsonRpcError, SdkProtocolError, TransportClosedError

__all__ = ["HarnessError", "TransportClosedError", "SdkProtocolError", "JsonRpcError"]
