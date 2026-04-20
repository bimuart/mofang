<div align="center">

# Free Cube

[English](./README.en.md) / [中文](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Online-brightgreen)](https://bimuart.github.io/cube/)

### *Fill cube colors freely. Every fill you make, every fill we verify.*
## 「 **Always Solvable** 」


 *Real-time legality checks, no invalid input.*
</div>

> *While you fill colors, the algorithm continuously computes and suggests valid options in real time.* <br>
> *This "fill-and-adjust" workflow guarantees that the final cube state is physically solvable and prevents invalid input.*

---

## 🚀 Try it now

**🔗 [https://bimuart.github.io/cube/](https://bimuart.github.io/cube/)**

---

## ✨ Key Features

- 🧠**Real-time fill guidance**: Based on cube math constraints, legal color options are computed in real time to prevent unsolvable configurations.
- 🎨**Flexible fill modes**:
  - **Fully manual fill**: You decide the color of every sticker.
  - **Partial random completion**: Keep the colors you care about fixed, and let the algorithm randomly complete the rest into a valid state.
- ⚡**Bidirectional solving**:
  - **Forward solve**: Generate steps from the current state back to solved.
  - **Reverse solve**: Generate steps from solved to the current state.
- 🌈**Color customization**: Full customization of cube appearance colors (theme color configuration).

---

## 🛠 Dependencies

- **Core logic library**: [cubejs](https://github.com/ldez/cubejs) (MIT)
- **Solving algorithm**: Herbert Kociemba (Two-Phase Algorithm)

