#!/usr/bin/env python3
"""Generate Windows ICO file with multiple sizes"""
from PIL import Image
import os

# 读取 1024x1024 基础图像
base_img = Image.open('icon_1024.png')
if base_img.mode != 'RGBA':
    base_img = base_img.convert('RGBA')

# 生成所有需要的尺寸
sizes = [16, 32, 48, 64, 128, 256]
images = []

for size in sizes:
    img = base_img.resize((size, size), Image.Resampling.LANCZOS)
    images.append(img)
    print(f'生成 {size}x{size}')

# 保存为 ICO 文件 - 新版 PIL 语法
# 第一个图像作为主图像，其余作为附加图像
first_img = images[0]
other_imgs = images[1:]

# 使用 sizes 参数指定所有尺寸
ico_sizes = [(img.width, img.height) for img in images]
first_img.save('icon.ico', format='ICO', sizes=ico_sizes, append_images=other_imgs)

print('✅ Windows icon.ico 生成完成')
print(f'ICO 文件大小: {os.path.getsize("icon.ico")} bytes')

# 验证
ico = Image.open('icon.ico')
print(f'ICO 格式: {ico.format}')
print(f'ICO 尺寸: {ico.size}')
print(f'ICO 模式: {ico.mode}')
