# Kubernetes deployment

Ce dossier contient une base Kustomize générique et un overlay `prod` prêt pour un déploiement derrière un `Ingress` Kubernetes exposé via Cloudflare.

## Ce qui est prévu

- Deux images séparées: `client` et `server`
- Frontend NGINX unprivileged sur `8080`
- Serveur Colyseus sur `2567`
- Probes `startup` / `readiness` / `liveness`
- Ingress HTTP uniquement, sans secret TLS côté cluster
- URL WebSocket injectée au runtime dans le client

## Build et publication des images

Une GitHub Action publie les images sur GHCR:

- `ghcr.io/<owner>/snakebattleroyal-client`
- `ghcr.io/<owner>/snakebattleroyal-server`

Le workflow pousse:

- un tag `latest` sur la branche par défaut
- un tag `sha-<commit>`
- un tag basé sur le nom de branche pour les branches `codex/**`

Fichier concerné:

- `.github/workflows/publish-images.yml`

## Déploiement prod

Rendu:

```bash
kubectl kustomize deploy/kubernetes/overlays/prod
```

Application:

```bash
kubectl apply -k deploy/kubernetes/overlays/prod
```

Vérifications utiles:

```bash
kubectl get pods -n snake-duel
kubectl get svc -n snake-duel
kubectl get ingress -n snake-duel
kubectl rollout status deployment/snake-duel-client -n snake-duel
kubectl rollout status deployment/snake-duel-server -n snake-duel
```

## Points d'attention

- L'overlay `prod` pointe sur `snake.raphcvr.me` et `apisnake.raphcvr.me`.
- Si ton `IngressClass` n'est pas `nginx`, remplace `spec.ingressClassName` dans l'overlay prod.
- Les manifests partent du principe que Cloudflare termine le TLS et parle en HTTP vers l'Ingress.
- Le serveur reste volontairement à `1` replica: l'état Colyseus est actuellement en mémoire. Passer à plusieurs replicas demandera un backend de présence/réservation externe avant d'être réellement sûr.
- Si le package GHCR n'est pas public, ajoute un `imagePullSecret` avant déploiement sur le cluster.
