# KAME·KAME

Juego web en el que haces con tu cuerpo los gestos de técnicas míticas del anime y de Mortal Kombat delante de la cámara, y el efecto aparece sobre ti en tiempo real.

La detección de pose usa [MediaPipe Pose Landmarker](https://developers.google.com/mediapipe/solutions/vision/pose_landmarker) y todo se procesa en el navegador: el vídeo no sale de tu equipo.

## Técnicas

| | Técnica | Personaje | Cómo se hace |
|---|---|---|---|
| 🌊 | Kamehameha | Goku · Dragon Ball | Junta las manos a un lado de la cadera y aguanta para cargar. Luego súbelas juntas delante del pecho. |
| 🌕 | Genkidama | Goku · Dragon Ball | Levanta las dos manos por encima de la cabeza y aguanta para reunir energía. Bájalas para lanzarla. |
| ⚡ | Super Saiyan | Goku · Dragon Ball | Puños a la altura de la cintura con los codos doblados hacia fuera, en tensión, ~1 segundo. |
| 🪝 | Get over here! | Scorpion · Mortal Kombat | Con la mano cerca del pecho, extiende un brazo recto hacia el lado de golpe. |
| ❄️ | Congelación | Sub-Zero · Mortal Kombat | Cruza los brazos en X delante del pecho y aguanta un instante. |
| 🌩️ | Rayo de Raiden | Raiden · Mortal Kombat | Levanta un solo brazo por encima de la cabeza (el otro abajo) y aguanta. |

## Controles

- **1–6**: lanzar cada efecto sin hacer el gesto (útil para probar)
- **S**: mostrar u ocultar el esqueleto detectado
- **M**: activar o silenciar el sonido

También puedes jugar sin cámara con el botón **Probar sin cámara**.

## Consejos

- Ponte a 1,5–2 m para que se te vea de cintura para arriba (mejor aún, de rodillas para arriba).
- Una buena luz de frente ayuda mucho a la detección.

## Cómo ejecutarlo

No necesita build ni dependencias: son tres archivos estáticos (`index.html`, `style.css`, `game.js`). Como la cámara solo funciona en un contexto seguro, sírvelo desde `localhost` o HTTPS:

```bash
python3 -m http.server 8000
```

y abre <http://localhost:8000>.

---

Hecho por [ablancodev](https://ablancodev.com)
