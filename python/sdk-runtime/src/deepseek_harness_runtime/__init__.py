"""Compatibility imports for the pre-rebrand runtime module."""

from yharness_runtime import (
    LEGACY_PACKAGE_METADATA_FILENAME,
    LEGACY_RUNTIME_EXECUTABLE_PREFIX,
    PACKAGE_METADATA_FILENAME,
    RUNTIME_MODE_ENV_VAR,
    LEGACY_RUNTIME_MODE_ENV_VAR,
    RUNTIME_EXECUTABLE_PREFIX,
    bundled_package_dir,
    bundled_runtime_path,
    main,
    resolve_bundled_launch_args,
)

# Keep the old public constant value for callers that inspect package data.
PACKAGE_METADATA_FILENAME = LEGACY_PACKAGE_METADATA_FILENAME

__all__ = [
    "PACKAGE_METADATA_FILENAME",
    "LEGACY_PACKAGE_METADATA_FILENAME",
    "RUNTIME_EXECUTABLE_PREFIX",
    "LEGACY_RUNTIME_EXECUTABLE_PREFIX",
    "RUNTIME_MODE_ENV_VAR",
    "LEGACY_RUNTIME_MODE_ENV_VAR",
    "bundled_package_dir",
    "bundled_runtime_path",
    "main",
    "resolve_bundled_launch_args",
]
