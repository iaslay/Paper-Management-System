"""本机模型密钥加密，Windows 主密钥由当前系统账号保护。"""
import ctypes
import os
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken
from .reading_service import fail


def windows_protect(data, decrypt=False):
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    source = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing))
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(incoming), "论文看板模型密钥", None, None, None, 1, ctypes.byref(outgoing))
    if not ok:
        fail("系统密钥保护失败，请检查当前 Windows 账号。", "secret_unavailable", 503)
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        ctypes.windll.kernel32.LocalFree(outgoing.data)


class SecretStore:
    def __init__(self, data_dir: Path):
        self.path = data_dir / ".model-key"

    def cipher(self):
        supplied = os.getenv("PAPERBOARD_SECRET_KEY")
        if supplied:
            try:
                return Fernet(supplied.encode("ascii"))
            except (ValueError, UnicodeError):
                fail("环境中的模型主密钥格式不正确。", "secret_unavailable", 503)
        if not self.path.exists():
            key = Fernet.generate_key()
            sealed = b"W1" + windows_protect(key) if os.name == "nt" else b"F1" + key
            try:
                with self.path.open("xb") as stream:
                    stream.write(sealed)
                self.path.chmod(0o600)
            except FileExistsError:
                pass
        content = self.path.read_bytes()
        try:
            key = windows_protect(content[2:], decrypt=True) if content[:2] == b"W1" and os.name == "nt" else content[2:] if content[:2] == b"F1" else b""
            return Fernet(key)
        except (ValueError, OSError):
            fail("无法打开本机模型主密钥，请在设置中重新配置。", "secret_unavailable", 503)

    def encrypt(self, value):
        return self.cipher().encrypt(value.encode("utf-8")).decode("ascii") if value else ""

    def decrypt(self, value):
        try:
            return self.cipher().decrypt(value.encode("ascii")).decode("utf-8") if value else ""
        except (InvalidToken, UnicodeError):
            fail("模型密钥无法解密，请重新填写密钥。", "secret_unavailable", 503)
