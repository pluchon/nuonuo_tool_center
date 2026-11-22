"""把本地分级模型转成 int8 动态量化版（model.int8.onnx），应用发现它就优先用，约快一倍。

用法（只在本机运行，不联网传图）：
  uv run -p 3.11 --with onnxruntime==1.32.0 --with onnx==1.23.2 python scripts/quantize-model.py <模型目录>
模型目录例如 D:\\ltm-dev\\models\\wd-swinv2-tagger-v3；原模型不动，目标已存在时不覆盖。
这两个版本在 679 张图（55 张 R-18）上验证过：R-18 零漏判。
"""

from __future__ import annotations

import logging
import os
import sys
import time

from onnxruntime.quantization import QuantType, quantize_dynamic

logger = logging.getLogger(__name__)

SOURCE_NAME = "model.onnx"
TARGET_NAME = "model.int8.onnx"


# 量化一个模型目录；返回生成文件的字节数
def quantize(model_dir: str) -> int:
    src = os.path.join(model_dir, SOURCE_NAME)
    dst = os.path.join(model_dir, TARGET_NAME)
    if not os.path.isfile(src):
        raise FileNotFoundError(f"找不到 {src}")
    if os.path.exists(dst):
        raise FileExistsError(f"{dst} 已存在，不覆盖")
    tmp = dst + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    # 只量化 MatMul / Gemm 的权重，激活在运行时动态量化
    quantize_dynamic(src, tmp, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"])
    os.rename(tmp, dst)
    return os.path.getsize(dst)


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if len(argv) != 2:
        logger.error("用法：quantize-model.py <模型目录>")
        return 2
    started = time.time()
    size = quantize(argv[1])
    logger.info("已生成 %s（%d 字节，用时 %.1f 秒）", TARGET_NAME, size, time.time() - started)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
