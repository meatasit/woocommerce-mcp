# PHP2Shell (CVE-2026-109618 / CVE-2026-109619) — เช็กลิสต์ร้าน WooCommerce

วันที่เขียน: 2026-10-21
สถานะ: [ ] ยังไม่เริ่ม  [ ] กำลังทำ  [ ] เสร็จแล้ว

## 0. สรุปสั้น ๆ

- PHP ออก security release แก้ช่องโหว่ 2 ตัวที่นำไปสู่ **unauthenticated RCE** บน web server ที่รัน PHP
- กระทบทุก SAPI ที่รับ web request: **PHP-FPM, mod_php (เสี่ยงสุด), php-cgi, LiteSpeed, FrankenPHP**
- **ไม่มี workaround ที่กันได้ 100%** ทีม PHP บอกตรง ๆ ว่า ini settings ไม่ช่วย ต้องอัปเดตอย่างเดียว
- repo `woocommerce-mcp` นี้เป็น Node.js ไม่มี PHP **ไม่ต้องแก้อะไรใน repo**
- สิ่งที่ต้องเช็กคือ **ร้าน WooCommerce ที่ MCP ต่อไปหา** (ค่า `WP_URL`)

### เวอร์ชันที่ปลอดภัย (ต้องเท่ากับหรือสูงกว่า)

| สาย | เวอร์ชันที่แก้แล้ว | หมายเหตุ |
|-----|-------------------|----------|
| 8.5 | **8.5.12** | |
| 8.4 | **8.4.27** | |
| 8.3 | **8.3.36** | แนะนำถ้าจะย้าย |
| 8.2 | **8.2.35** | EOL 31 ธ.ค. 2026 ควรวางแผนย้าย |
| 8.1 / 8.0 / 7.4 | ไม่มี official release | PHP ปล่อยแค่ source backport, distro/hosting อาจ patch ให้เอง ต้องถาม hosting |
| ต่ำกว่า 7.4 | ไม่มีอะไรเลย | ต้องย้ายเวอร์ชันทันที |

---

## 1. สิ่งที่ต้องเตรียมก่อนเริ่ม session ที่บ้าน

- [ ] เปิด Claude Desktop หรือรัน `claude remote-control` ในโฟลเดอร์นี้ เพื่อให้ Claude ใช้ browser บนเครื่องได้
- [ ] เตรียม URL ของ wp-admin และ login ไว้ (**พิมพ์ password เอง ไม่ต้องส่งให้ Claude**)
- [ ] ถ้ามี hosting panel (cPanel / Plesk / DirectAdmin / Cloudways / Kinsta ฯลฯ) เตรียม login ไว้ด้วย
- [ ] ถ้าดูแล server เอง เตรียม SSH access ไว้

---

## 2. ขั้นตอนตรวจสอบ (ให้ Claude ทำผ่าน browser หลังคุณ login)

### 2.1 ดูเวอร์ชัน PHP และ SAPI ใน WordPress

- [ ] เปิด `wp-admin` → **Tools → Site Health → Info → Server**
  - จด: `PHP version`, `Server architecture`, `Web server`, `PHP SAPI`
- [ ] เปิด **WooCommerce → Status** (แท็บ System status)
  - จด: `PHP version`, `WordPress version`, `WooCommerce version`
- [ ] บันทึกผลลงตาราง:

| รายการ | ค่าที่พบ |
|--------|----------|
| PHP version | |
| PHP SAPI (fpm / apache2handler / cgi / litespeed) | |
| Web server | |
| WordPress version | |
| WooCommerce version | |
| Hosting / วิธี deploy | |

### 2.2 ตัดสินว่าปลอดภัยหรือยัง

- [ ] เทียบ PHP version กับตารางในข้อ 0
- [ ] ถ้า **>= เวอร์ชันที่แก้แล้ว** → ปลอดภัย ข้ามไปข้อ 4
- [ ] ถ้า **ต่ำกว่า** → ทำข้อ 3

---

## 3. วิธีอัปเดต (เลือกตามแบบที่ใช้อยู่)

### 3A. Shared / Managed hosting (cPanel, Plesk, DirectAdmin, Cloudways, Kinsta, SiteGround, hosting ไทย)

- [ ] เปิดหน้าประกาศ / status page ของ hosting ดูว่า patch PHP2Shell แล้วหรือยัง
- [ ] ใน panel หา **PHP Version Selector / MultiPHP Manager / PHP Settings**
  - ถ้ามีเวอร์ชันที่ patch แล้ว (เช่น 8.3.36) ให้สลับไปใช้
  - ถ้ายังไม่มี → เปิด ticket ถาม hosting ว่าจะ patch เมื่อไร
- [ ] หลังสลับ กลับไปเช็ก Site Health ซ้ำว่าเวอร์ชันเปลี่ยนจริง

### 3B. ดูแล server เอง (VPS / Dedicated / Docker)

- [ ] SSH เข้าไปแล้วเช็ก:
  ```bash
  php -v
  php -i | grep -i "server api"
  ```
- [ ] อัปเดตตาม distro:
  ```bash
  # Ubuntu / Debian
  sudo apt update && sudo apt upgrade php* -y

  # Ubuntu ที่ใช้ ppa:ondrej/php
  sudo apt update && sudo apt upgrade -y

  # AlmaLinux / Rocky / RHEL (remi)
  sudo dnf update php* -y
  ```
- [ ] restart service:
  ```bash
  sudo systemctl restart php8.3-fpm   # เปลี่ยนเลขตามเวอร์ชัน
  sudo systemctl restart apache2      # หรือ nginx
  ```
- [ ] ถ้าใช้ **Docker** (เช่น `php:8.3-fpm`, `wordpress:php8.3`) → pull image ใหม่แล้ว redeploy
  ```bash
  docker compose pull && docker compose up -d
  ```
- [ ] เช็ก `php -v` ซ้ำหลังอัปเดต

### 3C. ระหว่างรอ patch (ลดความเสี่ยงชั่วคราวเท่านั้น ไม่ใช่การแก้)

- [ ] ถ้าใช้ **mod_php** และเปลี่ยนได้ ให้ย้ายไป **PHP-FPM** (เสี่ยงน้อยกว่า)
- [ ] ปิด `session.upload_progress.enabled = 0` ใน php.ini (เป็น path หนึ่งที่ถูกใช้โจมตี)
- [ ] เปิด WAF (Cloudflare / Wordfence) ถ้ามี
- [ ] จำกัด memory ของ PHP worker ด้วย cgroup / container limit (AlmaLinux แนะนำเป็น backstop)

---

## 4. หลังอัปเดตเสร็จ (ทำทุกข้อแม้จะ patch ทันเวลา)

### 4.1 ยืนยันเวอร์ชัน

- [ ] Site Health แสดงเวอร์ชันที่ patch แล้ว
- [ ] เว็บหน้าบ้านและ checkout ยังทำงานปกติ

### 4.2 เช็กร่องรอยว่าโดนไปก่อนหรือเปล่า

- [ ] **Users → All Users** มี admin แปลก ๆ ที่ไม่รู้จักไหม
- [ ] **Plugins** มี plugin ที่ไม่ได้ติดตั้งเองไหม
- [ ] ไฟล์ `.php` ที่ไม่ควรมีใน `wp-content/uploads/` (ถ้ามี SSH):
  ```bash
  find wp-content/uploads -name "*.php" -mtime -30
  find . -name "*.php" -mtime -7 -not -path "./wp-content/cache/*"
  ```
- [ ] ถ้าใช้ Wordfence / Sucuri ให้รัน scan เต็ม
- [ ] ดู access log หา request แปลก ๆ ช่วง 1-2 สัปดาห์ที่ผ่านมา (POST ไปที่ไฟล์ .php ที่ไม่รู้จัก, user-agent แปลก)

### 4.3 หมุน credential ที่เกี่ยวกับ MCP นี้

- [ ] **WooCommerce → Settings → Advanced → REST API** → revoke key เดิม สร้างใหม่ (Read only)
- [ ] อัปเดต `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET` ทุกที่ที่รัน `woocommerce-mcp` (Claude Desktop config, docker env, ฯลฯ)
- [ ] (ถ้าสงสัยว่าโดน) เปลี่ยน password admin ทุกคน และ regenerate salts ใน `wp-config.php`

---

## 5. ผลสรุป (ให้ Claude กรอกตอนจบ)

| รายการ | ผล |
|--------|-----|
| PHP ก่อนอัปเดต | |
| PHP หลังอัปเดต | |
| วิธีที่ใช้ (3A / 3B) | |
| พบร่องรอยผิดปกติ | ไม่พบ / พบ: ... |
| หมุน WC API key แล้ว | ใช่ / ไม่ |
| สิ่งที่ยังค้าง | |

---

## หมายเหตุสำหรับ Claude ใน session ที่บ้าน

- อ่านไฟล์นี้ก่อนเริ่ม แล้วทำตามข้อ 2 → 3 → 4 ตามลำดับ ติ๊ก checkbox ในไฟล์นี้ไปเรื่อย ๆ
- เปิด browser ไปที่ wp-admin แล้ว **ให้ผู้ใช้ login เอง** ห้ามขอหรือพิมพ์ password
- อ่านค่าจากหน้า Site Health / WooCommerce Status แล้วรายงานกลับเป็นตารางข้อ 2.1
- ห้ามรันคำสั่งอัปเดต server หรือ revoke key โดยไม่ถามก่อน ให้เสนอคำสั่งแล้วรอยืนยัน
- จบงานให้กรอกข้อ 5 ในไฟล์นี้

## อ้างอิง

- https://github.com/php/php-src/releases/tag/php-8.2.35
- https://www.tenable.com/blog/php2shell-cve-2026-109618-cve-2026-109619-frequently-asked-questions-about-critical-php-remote
- https://almalinux.org/blog/2026-10-21-php2shell-cve-2026-109618-cve-2026-109619/
- https://github.com/NCSC-NL/php2shell
- https://www.helpnetsecurity.com/2026/10/21/php2shell-php-vulnerabilities-patched-cve-2026-109618-cve-2026-109619/
