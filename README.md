<div align="center">

# 自由魔方

中文 / [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Online-brightgreen)](https://bimuart.github.io/cube/)

### *自由填入魔方配色，每一次填充，我们都实时确保它*
## 「 **真实可解** 」


 *实时合法性校验，告别无效输入*
</div>

> *在你填入颜色的过程中，算法会实时计算并提示哪些颜色是可选的。* <br>
> *这种“边填边改”的逻辑确保了你最终生成的魔方状态在物理上绝对真实可解，告别无效输入。*

---

## 🚀 立即体验

**🔗 [https://bimuart.github.io/cube/](https://bimuart.github.io/cube/)**

---

## ✨ 核心特性

- 🧠**实时的填充提示**：基于魔方数学约束，实时计算当前色块的合法颜色选项，防止出现不可解的配色。
- 🎨**灵活的填充模式**：
  - **全自由填充**：完全由你决定每一个面的颜色。
  - **半随机补全**：固定你感兴趣的部分颜色，其余色块由算法随机生成合法状态。
- ⚡**双向求解算法**：
  - **标准求解**：给出从当前状态还原到初始状态的步骤。
  - **逆向求解**：给出从初始状态解决到当前状态的步骤。
- 🌈**颜色自定义**：支持魔方外观颜色的全面自定义（主题色配置）。

---

## 🛠 依赖

- **核心逻辑库**：[cubejs](https://github.com/ldez/cubejs) (MIT)
- **求解算法**：Herbert Kociemba (Two-Phase Algorithm)
