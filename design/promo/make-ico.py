"""把幾張 PNG 包成一個 .ico（Windows 與瀏覽器都接受內含 PNG 的 ICO）。不需要額外套件。

用法：python make-ico.py 輸出.ico 16.png 32.png 48.png
"""

import struct
import sys


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 檔")
    return struct.unpack(">II", data[16:24])


def main() -> None:
    out, *inputs = sys.argv[1:]
    images = [open(path, "rb").read() for path in inputs]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    for data in images:
        w, h = png_size(data)
        # 寬高 256 以上在 ICO 裡記成 0
        entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(out, "wb") as f:
        f.write(header + entries + b"".join(images))


if __name__ == "__main__":
    main()
