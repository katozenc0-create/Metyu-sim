# Metyu-sim — çalışma kuralları (Claude için)

Bu depo özel `metyu` deposunun yayın kopyasıdır; ek olarak `index.html` (hafif simülatör), `durum/` (telefon durum sayfası) ve `surekli-sanal` iş akışı (sonuçlar `veri` dalında) buradadır.

## Tasarruf modu (her oturumda geçerli)
Kullanıcı Claude kontörünün tutumlu harcanmasını istiyor.
- Dosyaları baştan sona okuma. `simulator.html` ~150 KB: önce `grep -n` ile yeri bul, yalnızca o satırları oku.
- Alt ajan başlatma, geniş web araştırması yapma; istenmedikçe tek hedefli arama yeter.
- İstenen işi yap, kapsamı kendiliğinden büyütme. Büyük iş çıkıyorsa önce tek cümleyle sor.
- Yanıtlar kısa olsun (kullanıcı telefonda): sonuç, gereken karar, bağlantı.
- Uzun testi bir kez, sonda çalıştır: `node test/karar.mjs` (~2 dk; `--hizli` ~30 sn).

## Harita
- `simulator.html`: sayfa + ortak motor. `// ENGINE-START … ENGINE-END` (hesap, emir, stratejiler, göstergeler, filtreler) ve `// SHARED-START … SHARED-END` (mum çekme, backtest, walk-forward öğrenici, `WF` eşikleri).
- `metyu-runner.mjs`: 7/24 sanal portföy; motoru `simulator.html`'den yükler. Bölümler `// ----------` başlıklarıyla ayrılı (durum, portföy riski, fiyat akışı, ajan, öğrenme, rapor, Telegram, durum sayfası).
- `test/karar.mjs`: ağsız karar testi. `test/baglanti.mjs`, `arastirma/arastirma.mjs`: gerçek veri ister (yalnızca GitHub'da çalışır).
- `.github/workflows/`: `karar-testi` (her değişiklik), `canli-test` (push 12 dk, elle 40 dk), `arastirma`.

## Kurallar
- Yalnızca sanal para: borsa anahtarı, cüzdan ya da emir gönderen kod eklenmez.
- İki depo: özel `metyu` (ana geliştirme) ve herkese açık `Metyu-sim` (yayın kopyası). `metyu-runner.mjs`, `simulator.html` (ayrıca `tam/index.html` olarak) ve `test/karar.mjs` değişince `Metyu-sim`'e de kopyalanır.
- `main`'e doğrudan push yok: dal + pull request. Özel depoda Actions dakikası kotadan düşer.
- Kullanıcıya dönük metinler Türkçe; kod yorumları İngilizce.
- Bu ortamdan borsalara erişim yok; gerçek veri sınaması GitHub Actions'ta yapılır.

## Takip
Bulunan sorunlar ve durumları `TAKIP.md` dosyasında (özel `metyu` deposu). Bir sorunu düzeltince ya da yenisini bulunca o dosyayı güncelle.
