import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator
import numpy as np
from sympy import abc, lambdify, parse_expr
from sympy.parsing.sympy_parser import (
    implicit_multiplication_application,
    standard_transformations,
)

# 1. Input fungsi dari user (Otomatis deteksi perkalian terselubung)
input_user = input("Masukkan fungsi/pertidaksamaan: ")
input_siap = input_user.replace("^", "**")
transformasi = standard_transformations + (implicit_multiplication_application,)

operator = next((op for op in ["<=", ">=", "<", ">", "="] if op in input_siap))
ruas_kiri, ruas_kanan = input_siap.split(operator)

# 2. Proses fungsi matematika ke angka NumPy
f_total = parse_expr(ruas_kiri, transformations=transformasi) - parse_expr(
    ruas_kanan, transformations=transformasi
)
f_num = lambdify((abc.x, abc.y), f_total, "numpy")

# 3. Membuat Grid Data Koordinat (-10 sampai 10)
X, Y = np.meshgrid(np.linspace(-10, 10, 400), np.linspace(-10, 10, 400))
Z = f_num(X, Y)

# 4. Gambar Grafik Menggunakan Matplotlib
fig, ax = plt.subplots(figsize=(7, 7))

if operator == "=":
    ax.contour(X, Y, Z, levels=[0], colors="blue", linewidths=2)
else:
    # Kamus kondisi pertidaksamaan untuk arsir daerah
    kondisi = {
        "<=": Z <= 0,
        "<": Z < 0,
        ">=": Z >= 0,
        ">": Z > 0,
    }[operator]
    ax.contourf(X, Y, kondisi, levels=[0.5, 1.5], colors=["#a2c4c9"], alpha=0.6)
    ax.contour(X, Y, Z, levels=[0], colors="blue", linewidths=1.5)

# 5. Pindahkan angka skala ke Sumbu Tengah & Set Grid 1x1
ax.spines["left"].set_position("zero")
ax.spines["bottom"].set_position("zero")
ax.spines["right"].set_color("none")
ax.spines["top"].set_color("none")

ax.xaxis.set_major_locator(MultipleLocator(1))
ax.yaxis.set_major_locator(MultipleLocator(1))
ax.grid(True, color="lightgray", linestyle="-", linewidth=0.5)

plt.xlim(-10, 10)
plt.ylim(-10, 10)
plt.title(f"Grafik: {input_user}")
plt.show()
