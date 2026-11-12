# metyu-sim

Sanal para (paper) simülatörü. Gerçek emir, anahtar ya da cüzdan bağlantısı yoktur; yalnızca herkese açık fiyat verisini okur.

## 7/24 çalıştırıcı (Railway)

`metyu-runner.mjs` ve `simulator.html` birlikte çalışır (çalıştırıcı motoru sayfadan okur). Yalnızca sanal para; anahtar, cüzdan ya da emir yok.

Railway'de: **New Project → Deploy from GitHub repo → bu depo**. Sonra Variables: `METYU_DATA_DIR=/data`, `METYU_VIEW_KEY=` (en az 12 karakterlik uzun anahtar). Volumes: bağlama yolu `/data`. Settings → Networking → Generate Domain. Sayfayı ilk kez `https://ADRES/?k=ANAHTAR` ile aç.

Bu depo, özel `metyu` deposunun yayın kopyasıdır; ana geliştirme orada yapılır.
