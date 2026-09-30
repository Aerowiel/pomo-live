# pomo-live

Un pomodoro qu'on suit en direct : l'éditeur lance ses sessions, les autres suivent son statut avec un code court.
En ligne sur https://pomo-live.fly.dev.

## Fonctionnement

- Un serveur Node 24 sans dépendance (`server.js`) sert l'interface (`public/`) et pousse l'état des salons en Server-Sent Events.
- Tout le calcul des phases vit dans `public/timeline.js`, partagé entre le navigateur et les tests.
- Les salons sont en mémoire. Après un redémarrage, chaque appareil éditeur recrée son salon (`/restore`).
- Les salons épinglés (`PINNED_ROOMS`, secret Fly) existent dès le démarrage et n'expirent jamais.

## Déployer

Rien ne tourne en local : les tests s'exécutent dans le build Docker, et un test en échec bloque le déploiement.

```sh
fly deploy --remote-only --ha=false
```

`--ha=false` est indispensable : l'état est en mémoire, il ne doit y avoir qu'une seule machine.

## Épingler un salon

```sh
fly ssh console -C "node /app/scripts/new-room.js mon-code"   # affiche code, secret et hash
fly secrets set PINNED_ROOMS="mon-code:HASH"
```

Le lien viewer est `https://pomo-live.fly.dev/view/CODE`. Le lien éditeur est `https://pomo-live.fly.dev/edit/CODE#SECRET` : c'est un mot de passe, ne pas le partager.
Pour le régénérer en cas de fuite, recommencer ces deux commandes.
