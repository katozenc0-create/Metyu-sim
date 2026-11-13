# metyu-sim

Sanal para (paper) simülatörü. Gerçek emir, anahtar ya da cüzdan bağlantısı yoktur; yalnızca herkese açık fiyat verisini okur.

## 7/24 çalıştırıcı (Railway)

`metyu-runner.mjs` ve `simulator.html` birlikte çalışır (çalıştırıcı motoru sayfadan okur). Yalnızca sanal para; anahtar, cüzdan ya da emir yok.

Railway'de: **New Project → Deploy from GitHub repo → bu depo**. Sonra Variables: `METYU_DATA_DIR=/data`, `METYU_VIEW_KEY=` (en az 12 karakterlik uzun anahtar). Volumes: bağlama yolu `/data`. Settings → Networking → Generate Domain. Sayfayı ilk kez `https://ADRES/?k=ANAHTAR` ile aç.

Bu depo, özel `metyu` deposunun yayın kopyasıdır; ana geliştirme orada yapılır.

## Ücretsiz sürekli sanal çalışma (GitHub Actions)

`.github/workflows/surekli-sanal.yml` çalıştırıcıyı ~5,5 saatlik çalışmalar halinde kesintisize yakın çalıştırır ve durumu `veri` dalına kaydeder; sonraki çalışma oradan devam eder.

- **Zincir:** biten çalışma bir sonrakini kendisi başlatır; arada birkaç dakika kalır.
- **Bekçi:** zamanlayıcı 30 dakikada bir bakar, çalışan yoksa başlatır. (GitHub zamanlanmış çalışmaları atlayabiliyor; eski 6 saatlik düzende bir atlama portföyü saatlerce izlemesiz bırakıyordu.)

Sonuçlar `veri` dalında: `metyu-log.txt` (olaylar), `metyu-trades.csv` (kapanan işlemler), `metyu-state.json` (portföy), `raporlar/` (haftalık rapor). Aradaki kısa boşlukta stoplar izlenmez; program açılınca barları borsadan doğrular ve stopları ilk fiyatta kontrol eder. Gerçek 7/24 değildir.

İlk çalıştırma: **Actions** sekmesi → **Sürekli sanal çalışma** → **Run workflow**. Telefondan durum: `durum/` sayfası.

## Karar testi ve güvenlik

`node test/karar.mjs` ağ kullanmadan risk kurallarını ve öğrenicinin yanlış alarm oranını sınar; her değişiklikte kendiliğinden çalışır. İş akışlarındaki hazır adımlar değişmez sürümlere sabitlidir, Dependabot ayda bir günceller. Ayrıntılar özel `metyu` deposundaki README'de: kanıt gücü, karantina, tasarruf modu, güvenlik.
