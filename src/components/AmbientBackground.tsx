import React, { useEffect, useState, useMemo } from 'react';
import {
  getAmbientState,
  AmbientState,
  CHECK_INTERVAL_MS,
  STARS_CONFIG,
  RAIN_CONFIG,
  pseudoRandom,
} from '../Environment';

export default function AmbientBackground() {
  const [ambientState, setAmbientState] = useState<AmbientState>(() => getAmbientState());
  const [isTabActive, setIsTabActive] = useState(true);

  // Comprobar visibilidad de la pestaña para pausar cuando no esté activa
  useEffect(() => {
    const handleVisibilityChange = () => {
      const active = !document.hidden;
      setIsTabActive(active);
      if (active) {
        setAmbientState(getAmbientState());
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Actualizar el estado del ambiente cada minuto (60000ms)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) {
        setAmbientState(getAmbientState());
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // Generar datos estáticos de estrellas (posiciones deterministas)
  const stars = useMemo(() => {
    const items = [];
    for (let i = 0; i < STARS_CONFIG.count; i++) {
      const left = pseudoRandom(i * 3 + 1) * 100;
      const top = pseudoRandom(i * 3 + 2) * 100;
      const size =
        STARS_CONFIG.minSizePx +
        pseudoRandom(i * 3 + 3) * (STARS_CONFIG.maxSizePx - STARS_CONFIG.minSizePx);
      const opacity =
        STARS_CONFIG.minOpacity +
        pseudoRandom(i * 5 + 1) * (STARS_CONFIG.maxOpacity - STARS_CONFIG.minOpacity);
      const duration =
        STARS_CONFIG.minTwinkleDurationSec +
        pseudoRandom(i * 7 + 2) *
          (STARS_CONFIG.maxTwinkleDurationSec - STARS_CONFIG.minTwinkleDurationSec);
      const delay = pseudoRandom(i * 11 + 3) * 5;

      items.push({ id: i, left, top, size, opacity, duration, delay });
    }
    return items;
  }, []);

  // Generar datos estáticos de lluvia (posiciones deterministas)
  const rainDrops = useMemo(() => {
    const items = [];
    for (let i = 0; i < RAIN_CONFIG.count; i++) {
      const left = pseudoRandom(i * 4 + 1) * 100;
      const height =
        RAIN_CONFIG.minHeightPx +
        pseudoRandom(i * 4 + 2) * (RAIN_CONFIG.maxHeightPx - RAIN_CONFIG.minHeightPx);
      const duration =
        RAIN_CONFIG.minDurationSec +
        pseudoRandom(i * 4 + 3) * (RAIN_CONFIG.maxDurationSec - RAIN_CONFIG.minDurationSec);
      const delay = pseudoRandom(i * 4 + 4) * 2;
      const opacity = 0.2 + pseudoRandom(i * 9 + 1) * 0.4;

      items.push({ id: i, left, height, duration, delay, opacity });
    }
    return items;
  }, []);

  const { backgroundStyle, showStars, showRain, weather } = ambientState;

  return (
    <div
      className="fixed inset-0 w-full h-full pointer-events-none overflow-hidden"
      style={{
        zIndex: 0,
        ...backgroundStyle,
        transition: 'background 2s ease-in-out, background-color 2s ease-in-out',
      }}
    >
      <style>{`
        @keyframes ambient-twinkle {
          0%, 100% {
            opacity: 0.2;
            transform: scale(0.8);
          }
          50% {
            opacity: 0.95;
            transform: scale(1.2);
          }
        }

        @keyframes ambient-rain {
          0% {
            transform: translateY(-50px);
            opacity: 0;
          }
          15% {
            opacity: 1;
          }
          85% {
            opacity: 1;
          }
          100% {
            transform: translateY(105vh);
            opacity: 0;
          }
        }
      `}</style>

      {/* Capa de Estrellas (sólo de noche sin nubes) */}
      {showStars && isTabActive && (
        <div className="absolute inset-0 w-full h-full pointer-events-none">
          {stars.map((star) => (
            <div
              key={star.id}
              className="absolute rounded-full bg-white"
              style={{
                left: `${star.left}%`,
                top: `${star.top}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                opacity: star.opacity,
                boxShadow: '0 0 3px rgba(255, 255, 255, 0.8)',
                animation: `ambient-twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
              }}
            />
          ))}
        </div>
      )}

      {/* Capa de Lluvia (lluvia / tormenta) */}
      {showRain && isTabActive && (
        <div className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden">
          {rainDrops.map((drop) => (
            <div
              key={drop.id}
              className="absolute rounded-full"
              style={{
                left: `${drop.left}%`,
                top: `-30px`,
                width: '1px',
                height: `${drop.height}px`,
                backgroundColor:
                  weather === 'storm' ? RAIN_CONFIG.stormColor : RAIN_CONFIG.color,
                opacity: drop.opacity,
                transform: `rotate(${RAIN_CONFIG.angleDeg}deg)`,
                animation: `ambient-rain ${drop.duration}s linear ${drop.delay}s infinite`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
