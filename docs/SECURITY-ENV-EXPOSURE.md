# Canh bao: file .env da bi Git-track

Trang thai: OPEN — chua xu ly xong. Chua duoc phep push khi muc nay con mo.

## Hien trang

- File .env dang duoc Git-track, du co dong .env* trong .gitignore (Git khong bo track file da co trong index).
- Da co 3 commit tren origin/main chua file nay. Commit dau tien: 867659b.
- File .env hien tai chua 131 bien. Quet masked bang may (chi in ten + do dai + scheme, KHONG in gia tri): 23 bien khop mau secret, trong do 3 EMPTY, 3 SHORT_NUMBER (ngan sach / thoi gian, khong phai khoa), 17 co gia tri that.
- Repo KHONG cong khai: API va trang HTML GitHub tra 404 trong khi git fetch van lay duoc refs. Muc do giam so voi kich ban public, nhung clone cu / log CI van giu khoa nen van phai rotate.

## Da xac minh bang may (chu ky 2026-11-01)

- .env VAN con trong index: lenh git ls-files --error-unmatch .env tra ve .env. Do la ly do khong push du co dong .env* trong .gitignore.
- .gitignore da them dong phu dinh `!.env.example` ngay sau dong .env. Kiem chung bang git check-ignore: duong dan .env.testprobe bi dong 34 (.env*) bat, con .env.example KHONG bi ignore. Duong dan co hai ket qua trai nguoc chung mot cap hinh.
- .env.example da ton tai tu truoc, KHONG phai do chung ky nay tao: 528 dong, 30467 byte, 123 bien co ten, da duoc Git-track, khong bi ignore ngay ca truoc khi them dong phu dinh.
- Quet .env.example o che do MASKED (chi in ten bien + do dai, khong in gia tri): SUSPECT=0. Phan loai 119 dong co gia tri: 17 PLACEHOLDER, 3 EMPTY (QDRANT_API_KEY, TMO_API_TOKEN, GITHUB_TOKEN), 3 NUM_OR_BOOL, 96 URL/PATH/flag. 12 dong dai tu 32 ky tu tro len deu thuoc nhom co ENABLE_* va chua danh sach ten cong cu kem chu thich, khong phai khoa.
- Khong co hook pre-commit/pre-push trong .git/hooks. Khong co lop bao ve o muc git, chi co quy tac infra-guard cua he thong.
- Working tree hien tai: .env (da sua 17 dong), .gitignore (sua), tai lieu nay (moi). Chua commit gi trong chu ky nay.
- Chi doc ten bien de lap danh sach rotate. Gia tri KHONG duoc ghi vao tai lieu, log hay commit.

## Bien can rotate (theo ten)

### Token / API key ben thu ba

- CLOUDFLARE_API_TOKEN
- GITHUB_TOKEN
- TMO_API_TOKEN
- QDRANT_API_KEY

### Nhom Jina

- JINA_API_KEY_1
- JINA_API_KEY_2
- JINA_API_KEY_3

### Nhom NVIDIA

- NVIDIA_API_KEY_1
- NVIDIA_API_KEY_2
- NVIDIA_API_KEY_3
- NVIDIA_API_KEY_4

### Nhom Tavily

- TAVILY_API_KEY_1
- TAVILY_API_KEY_2
- TAVILY_API_KEY_3

### Nhom Serper

- SERPER_API_KEY_1

### Nhom Zen

- ZEN_API_KEY_1
- ZEN_API_KEY_2
- ZEN_API_KEY_3

### Cloudflare R2

- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
- R2_ACCOUNT_ID

### Database / Neo4j

- DATABASE_URL
- NEO4J_PASSWORD
- NEO4J_USER
- NEO4J_URI

## Bang P0/P1/P2 (dung may, chi theo ten bien — khong ghi gia tri)

| Muc | So bien | Ten bien | Ly do xep muc |
| --- | --- | --- | --- |
| P0-A | 17 | NVIDIA_API_KEY_1, NVIDIA_API_KEY_2, NVIDIA_API_KEY_3, NVIDIA_API_KEY_4, TAVILY_API_KEY_1, TAVILY_API_KEY_2, TAVILY_API_KEY_3, JINA_API_KEY_1, JINA_API_KEY_2, JINA_API_KEY_3, SERPER_API_KEY_1, R2_SECRET_ACCESS_KEY, R2_ACCESS_KEY_ID, CLOUDFLARE_API_TOKEN, NEO4J_PASSWORD, ZEN_API_KEY_1, ZEN_API_KEY_2 | Gia tri SAME tren ca 3 blob .env tren remote (bang may, muc "Fingerprint da chot"). Da lo. Rotate TRUOC moi thao tac git nao. |
| P0-B | 1 | ZEN_API_KEY_3 | Co gia tri that o local, ABSENT tren ca 3 blob remote — CHUA tung len remote. Push 8 commit dang cho se lam lo khoa nay. |
| P1 | 3 | GITHUB_TOKEN, QDRANT_API_KEY, TMO_API_TOKEN | Rong o local VA rong tren ca 3 blob remote (bang may). Khong lo gia tri gi. Chi can kiem tra lai neu duoc gan gia tri moi. |
| P1-info | ~108 | Cac bien URL / URI / path / flag con lai, gom DATABASE_URL va NEO4J_URI | Lo thong tin ha tang: host, duong dan, cau hinh. DATABASE_URL thuong chua mat khau trong chuoi — chu so hu can tu kiem tra. |
| P2 | 3 | GOAL_LOOP_TOKEN_BUDGET, SUBAGENT_TOKEN_BUDGET, LLM_TIMEOUT_MS_PER_TOKEN | So nguyen sach va thoi gian, khong phai khoa. Khong can rotate. |

Thu tu rotate: P0-A truoc (17 khoa da lo). P0-B (ZEN_API_KEY_3) chua lo duoc tren remote nhung se lo ngay neu push 8 commit hien tai. P1 va P1-info sau.

## Fingerprint da chot (so sanh bang may, khong in gia tri)

So sanh 21 ten bien giua file .env local va 3 blob .env da tung ton tai tren remote. Ket qua chi ghi trang thai SAME / DIFF / EMPTY / ABSENT.

- 17 khoa co gia tri that: SAME tren CA 3 blob remote — chua khoa nao duoc doi gia tri sau lan lo.
- ZEN_API_KEY_3: co gia tri that o local, ABSENT tren ca 3 blob remote — chua tung len remote.
- GITHUB_TOKEN, QDRANT_API_KEY, TMO_API_TOKEN: EMPTY o local va EMPTY tren ca 3 blob remote.
- Tong hop may: SAME_ALL3=17, ALL_EMPTY=3, ALL_ABSENT=1, MIXED=0.

| Commit tao blob | Blob SHA-1 cua file .env |
| --- | --- |
| 867659b | 77a66c6472f1b807c7f696a02f8ae33f7e71bc36 |
| ef0b95b | b221596a387ce87c9d3010fae9a7a7e3335d661a |
| 8c6b793 | 9674355b64c9541f019f300554062c879dd3874c |

Dinh chinh so voi phien ban truoc cua tai lieu: ZEN_API_KEY_1, ZEN_API_KEY_2 va R2_ACCESS_KEY_ID hoa ra CUNG nam trong blob remote (SAME), nen da gop vao P0-A va muc P0-C bi bo. Chi ZEN_API_KEY_3 thuoc loai chi-co-o-local.

Chenh lech con mo: danh sach fingerprint nay co 18 ten co gia tri that, nhieu hon so dem o muc Hien trang. Can doi chieu them o chu ky sau; chua ket luan nguyen nhan.

## Blast radius da xac minh (git read-only)

| Muc | Ket qua | Cach xac minh |
| --- | --- | --- |
| Ref nao chua file .env | CHI origin/main. origin/master va origin/TMO KHONG chua. | git cat-file -e <ref>:.env |
| Commit remote cham .env | 3 commit: 867659b (tao moi file, 2026-09-27), ef0b95b va 8c6b793 (2026-09-28) | git log --all -- .env |
| 3 commit do da len remote chua | CO, 867659b la ancestor cua origin/main | git merge-base --is-ancestor 867659b origin/main |
| 2 commit local cham .env | 972754a va 5792b02, CHUA co ref nao o remote | git branch -a --contains |
| HEAD cua origin/main | VAN con chua .env | git cat-file -e origin/main:.env |
| Ahead / behind | ahead 8, behind 0 | git rev-list --count |
| So blob .env da tung ton tai | 15 | git rev-list --objects --all -- .env |
| Tag | 0, chi 5 ref (main, origin/HEAD, origin/TMO, origin/main, origin/master) | git for-each-ref |
| Repo public hay private | PRIVATE (404 o API va HTML) | web_fetch api.github.com/repos |

## Con thieu bang chung (chua xac minh duoc)

- (Da chot) Bang SAME / DIFF da chay bang may xong trong chu ky nay — xem muc "Fingerprint da chot".
- Chua kiem tra duoc fork, cache clone, log CI, va nguoi so huu. May nay khong co gh CLI va API GitHub da het rate limit.
- (Da chot) 3 bien P1 deu rong o ca local va ca 3 blob remote — khong lo gia tri gi.

## Phuong an history rewrite (can chon 1)

### A) Giu lich su, chi tach file khoi Git (it rui ro nhat)

1. Giu nguyen 3 commit cu.
2. Dung git filter-repo xoa file .env khoi toan bo lich su.
3. Force-push lai origin/main.

Uu: giao dien cac commit giu nguyen. Nhuoc: lich su moi van chua gia tri cu, nen BAT BUOC rotate toan bo key o tren.

### B) Squash ve mot commit moi (sach nhat)

1. Tao orphan branch, chi giu trang thai file hien tai minus .env.
2. Force-push, gan lai remote.

Uu: khong con gia rieng nao trong lich su. Nhuoc: mat toan bo lich su commit, can thong bao team.

### C) Rotate truoc, rewrite sau (khuyen nghi)

1. Rotate toan bo 26 key o tren truoc khi lam bat ky thao tac git nao.
2. Sau do chon A hoac B.

Ly do: rewrite lich su khong xoa key khoi ban sao cua repository. Tu doi la cach bao ve thuc te.

## Checklist push (danh cho moi lan)

- [ ] Da chay git check-ignore -v .env va no tro ve quy tac dung.
- [ ] git ls-files --error-unmatch .env tra loi loi (khong con bi track).
- [ ] Da tao .env.example chi chua ten bien, gia tri rong.
- [ ] Khong con file .env trong staged area.
- [ ] Da chay quet secret tren staged diff truoc khi commit.
- [ ] Khong push khi con muc Canh bao nay OPEN.

## Cach dung lai cho lan sau

Sau khi chot duong A hoac B, chay lenh nay mot lan de chan no lai:

    git rm --cached .env
    git commit -m "chore: stop tracking .env"

Sau do .env chi con nam tren dia may, khong con nam trong Git.
