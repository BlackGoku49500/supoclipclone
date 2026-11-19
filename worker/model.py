"""Install a verified, multilingual CPU model from an immutable upstream revision."""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import time
from urllib.request import urlopen

REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
MODEL_URL = f"https://huggingface.co/Systran/faster-whisper-base/resolve/{REVISION}"
FILES = {
    "model.bin": (145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"),
    "tokenizer.json": (2203239, "7818adb6de9fa3064d3ff81226fdd675be1f6344"),
    "vocabulary.txt": (459861, "c9074644d9d1205686f16d411564729461324b75"),
    "config.json": (2309, "867cf1a0fece1394e01d55e287ba2f09a577c046"),
}


def fingerprint(name, size):
    if name == "model.bin":
        return hashlib.sha256()
    # The upstream tree identifies non-LFS files by their Git blob hashes.
    return hashlib.sha1(f"blob {size}\0".encode(), usedforsecurity=False)


def install(folder):
    folder.mkdir(parents=True, exist_ok=True)
    for name, (size, expected) in FILES.items():
        target = folder / name
        if target.exists() and target.stat().st_size == size:
            digest = fingerprint(name, size)
            with target.open("rb") as src:
                for block in iter(lambda: src.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() == expected:
                continue
        for attempt in range(3):
            tmp = None
            try:
                digest = fingerprint(name, size)
                with tempfile.NamedTemporaryFile(dir=folder, delete=False) as out:
                    tmp = Path(out.name)
                    with urlopen(f"{MODEL_URL}/{name}?download=true&revision={REVISION}&attempt={attempt}", timeout=90) as src:
                        for block in iter(lambda: src.read(1024 * 1024), b""):
                            out.write(block)
                            digest.update(block)
                if tmp.stat().st_size != size or digest.hexdigest() != expected:
                    raise OSError(f"Integrity check failed for {name}")
                tmp.chmod(0o644)
                os.replace(tmp, target)
                break
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)
            finally:
                if tmp:
                    tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    install(parser.parse_args().directory)
