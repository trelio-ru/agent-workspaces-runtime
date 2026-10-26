// Windows private-state transport. No PowerShell, CLR, profiles or module
// loader participate in startup. All requests arrive over anonymous pipes;
// stdout contains only the bounded protocol and stderr is never used.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <wincrypt.h>
#include <tlhelp32.h>
#include <appmodel.h>
#include <restartmanager.h>
#include <limits>
#include <optional>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>
#include <stdexcept>
#include <cstdint>

namespace {
constexpr size_t MaxValue = 1024 * 1024;
constexpr size_t MaxLine = 1400000;
struct Failure {};
void require(bool value) { if (!value) throw Failure{}; }

// Owners release OS allocations even when verification fails. Sensitive
// buffers are wiped before release; no OS error text or plaintext is logged.
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Local {
  HLOCAL value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};
struct Bytes {
  std::vector<BYTE> value;
  explicit Bytes(size_t size = 0) : value(size) {}
  ~Bytes() { if (!value.empty()) SecureZeroMemory(value.data(), value.size()); }
  Bytes(const Bytes&) = delete;
  Bytes& operator=(const Bytes&) = delete;
};
struct Text {
  std::string value;
  ~Text() { if (!value.empty()) SecureZeroMemory(value.data(), value.size()); }
};
void write(std::string_view value) {
  while (!value.empty()) {
    DWORD count = 0;
    require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value.data(),
      static_cast<DWORD>(value.size()), &count, nullptr) && count > 0);
    value.remove_prefix(count);
  }
}
void phase(std::string_view id, std::string_view name) {
  write("{\"id\":\""); write(id); write("\",\"phase\":\""); write(name); write("\"}\n");
}
void encode(const BYTE* data, DWORD size, Text& output) {
  DWORD length = 0;
  constexpr DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
  require(CryptBinaryToStringA(data, size, flags, nullptr, &length) != FALSE);
  output.value.resize(length);
  require(CryptBinaryToStringA(data, size, flags, output.value.data(), &length) != FALSE);
  // CryptBinaryToString includes the terminator in the queried allocation.
  output.value.resize(length);
  if (!output.value.empty() && output.value.back() == '\0') output.value.pop_back();
}
void decode(std::string_view input, Bytes& output, size_t limit = MaxValue) {
  require(!input.empty() && input.size() % 4 == 0 && input.size() <= MaxLine);
  bool padding = false;
  size_t paddingCount = 0;
  for (char c : input) {
    if (c == '=') { padding = true; require(++paddingCount <= 2); }
    else require(!padding && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') || c == '+' || c == '/'));
  }
  DWORD size = 0;
  require(CryptStringToBinaryA(input.data(), static_cast<DWORD>(input.size()),
    CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) != FALSE);
  require(size > 0 && size <= limit);
  output.value.resize(size);
  require(CryptStringToBinaryA(input.data(), static_cast<DWORD>(input.size()),
    CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, output.value.data(), &size, nullptr, nullptr) != FALSE);
  Text canonical;
  encode(output.value.data(), size, canonical);
  require(canonical.value == input);
}

void harden(std::string_view id, std::string_view kind, std::string_view encodedPath) {
  phase(id, "path_decode");
  Bytes pathBytes;
  decode(encodedPath, pathBytes, 12000);
  const auto* utf8 = reinterpret_cast<const char*>(pathBytes.value.data());
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8,
    static_cast<int>(pathBytes.value.size()), nullptr, 0);
  require(length > 0);
  std::wstring path(static_cast<size_t>(length), L'\0');
  require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8,
    static_cast<int>(pathBytes.value.size()), path.data(), length) == length);
  require(path.find(L'\0') == std::wstring::npos);

  phase(id, "identity");
  HANDLE rawToken = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken) != FALSE);
  Handle token(rawToken);
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  require(size > 0 && size < 65536);
  Bytes tokenInfo(size);
  require(GetTokenInformation(token.value, TokenUser, tokenInfo.value.data(), size, &size) != FALSE);
  PSID sid = reinterpret_cast<TOKEN_USER*>(tokenInfo.value.data())->User.Sid;
  require(IsValidSid(sid) != FALSE);

  // Work on one open object throughout read/write/verification. Opening the
  // final reparse point itself and rejecting it prevents following a junction
  // or symlink. No SACL access, privilege adjustment or administrator token is
  // requested. WRITE_OWNER is requested only for an actual owner correction.
  Handle target(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(target.value != INVALID_HANDLE_VALUE);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(target.value, &info) != FALSE);
  require(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  require(((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == (kind == "directory"));

  phase(id, "owner_read");
  PSID owner = nullptr;
  Local ownerDescriptor;
  require(GetSecurityInfo(target.value, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
    &owner, nullptr, nullptr, nullptr, &ownerDescriptor.value) == ERROR_SUCCESS);
  require(owner && IsValidSid(owner));
  if (!EqualSid(owner, sid)) {
    phase(id, "owner_write");
    Handle ownerTarget(CreateFileW(path.c_str(), WRITE_OWNER | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(ownerTarget.value != INVALID_HANDLE_VALUE);
    BY_HANDLE_FILE_INFORMATION ownerInfo{};
    require(GetFileInformationByHandle(ownerTarget.value, &ownerInfo) != FALSE);
    require(ownerInfo.dwVolumeSerialNumber == info.dwVolumeSerialNumber &&
      ownerInfo.nFileIndexHigh == info.nFileIndexHigh && ownerInfo.nFileIndexLow == info.nFileIndexLow);
    require(SetSecurityInfo(ownerTarget.value, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
      sid, nullptr, nullptr, nullptr) == ERROR_SUCCESS);
  }

  phase(id, "dacl_write");
  DWORD aclSize = static_cast<DWORD>(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) + GetLengthSid(sid);
  Bytes aclBuffer(aclSize);
  auto* acl = reinterpret_cast<PACL>(aclBuffer.value.data());
  require(InitializeAcl(acl, aclSize, ACL_REVISION) != FALSE);
  DWORD inheritance = kind == "directory" ? CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE : 0;
  require(AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid) != FALSE);
  require(SetSecurityInfo(target.value, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, acl, nullptr) == ERROR_SUCCESS);

  phase(id, "dacl_verify");
  Local verified;
  PACL actualAcl = nullptr;
  require(GetSecurityInfo(target.value, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &actualAcl, nullptr, &verified.value) == ERROR_SUCCESS);
  require(owner && EqualSid(owner, sid) && actualAcl && IsValidAcl(actualAcl) && actualAcl->AceCount == 1);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  require(GetSecurityDescriptorControl(verified.value, &control, &revision) != FALSE);
  require((control & SE_DACL_PROTECTED) != 0);
  void* rawAce = nullptr;
  require(GetAce(actualAcl, 0, &rawAce) != FALSE);
  const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
  require(ace->Header.AceSize == sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid));
  require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
    ace->Header.AceFlags == inheritance && ace->Mask == FILE_ALL_ACCESS &&
    EqualSid(const_cast<DWORD*>(&ace->SidStart), sid));
}

void dpapi(std::string_view id, std::string_view kind, std::string_view entropyText, std::string_view inputText) {
  Bytes entropy, input;
  decode(entropyText, entropy, 32); require(entropy.value.size() == 32);
  decode(inputText, input);
  DATA_BLOB inputBlob{ static_cast<DWORD>(input.value.size()), input.value.data() };
  DATA_BLOB entropyBlob{ static_cast<DWORD>(entropy.value.size()), entropy.value.data() };
  DATA_BLOB output{};
  // No LOCAL_MACHINE flag: ciphertext stays bound to the current user and
  // the exact origin entropy used by the previous ProtectedData implementation.
  BOOL ok = kind == "protect"
    ? CryptProtectData(&inputBlob, nullptr, &entropyBlob, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
    : CryptUnprotectData(&inputBlob, nullptr, &entropyBlob, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
  Local allocation;
  allocation.value = output.pbData;
  try {
    require(ok && output.cbData > 0 && output.cbData <= MaxValue);
    Text encoded;
    encode(output.pbData, output.cbData, encoded);
    write("{\"id\":\""); write(id); write("\",\"ok\":true,\"value\":\""); write(encoded.value); write("\"}\n");
  } catch (...) {
    if (output.pbData) SecureZeroMemory(output.pbData, output.cbData);
    throw;
  }
  SecureZeroMemory(output.pbData, output.cbData);
}

void request(std::string_view line) {
  std::vector<std::string_view> fields;
  size_t start = 0;
  for (;;) {
    size_t tab = line.find('\t', start);
    fields.push_back(line.substr(start, tab == std::string_view::npos ? tab : tab - start));
    if (tab == std::string_view::npos) break;
    require(fields.size() < 4); start = tab + 1;
  }
  // Invalid framing terminates the process before any path/credential action.
  require(fields.size() >= 3 && !fields[0].empty() && fields[0].size() <= 16);
  for (char c : fields[0]) require(c >= '0' && c <= '9');
  const auto id = fields[0], kind = fields[1];
  try {
    if (kind == "file" || kind == "directory") {
      require(fields.size() == 3 && line.size() <= 16384);
      harden(id, kind, fields[2]);
      write("{\"id\":\""); write(id); write("\",\"ok\":true}\n");
    } else {
      require((kind == "protect" || kind == "unprotect") && fields.size() == 4);
      dpapi(id, kind, fields[2], fields[3]);
    }
  } catch (...) {
    write("{\"id\":\""); write(id); write("\",\"ok\":false}\n");
    throw; // Failed private operations never continue with a partially trusted state.
  }
}
}


// Presentation-only bytes derived from the dedicated assistant logo, not a
// configurable image/path. Source SVG SHA-256:
// fbf526b22fb2324623e64aaa89fa5474d8d4cd6b4bb64c3255d22cdd1263131e.
// Exact source: trelio-ru/digital-assistants, plugin assets/trelio-assistant-logo.svg.
// Rasterized at 64x64 without changing its three bars or cursor geometry; PNG
// SHA-256 f10a5199f521f83ed900c4353a132cb1433094f73520c0608bba43793f7fbb53.
// Embedding in the SAME reviewed source/binary preserves the 100-file package
// bound and avoids a plugin-cache path, new executable or a Node.exe edit.
alignas(DWORD) BYTE AssistantConsoleIcon[] = {
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x40,
  0x00,0x00,0x00,0x40,0x08,0x06,0x00,0x00,0x00,0xaa,0x69,0x71,0xde,0x00,0x00,0x03,0xa6,0x49,0x44,0x41,
  0x54,0x78,0x9c,0xed,0xdb,0x4f,0x68,0x1c,0x65,0x18,0xc7,0xf1,0xcf,0xac,0xdb,0x34,0x2d,0x49,0x48,0x31,
  0x48,0x10,0xeb,0x1f,0x54,0x10,0x82,0x42,0x7b,0xe9,0x41,0x14,0xe9,0x49,0x14,0xf5,0xa4,0x88,0x3d,0x34,
  0x50,0xf0,0xa0,0x87,0x4a,0x55,0x8a,0x88,0xb6,0xa0,0xc1,0x3f,0x10,0x05,0x51,0x51,0x21,0x78,0xd2,0x83,
  0x22,0x2a,0x82,0x5a,0xf5,0x96,0x86,0xfa,0x17,0xb5,0x45,0x45,0xb4,0xd8,0xa0,0xd1,0x96,0x16,0xb5,0xb5,
  0xb1,0x21,0x4d,0x76,0x3d,0xbc,0x9b,0x74,0xb2,0x9d,0x4d,0x36,0xbb,0x1b,0x67,0xb6,0xcc,0x17,0x16,0x66,
  0xe6,0x9d,0x67,0xe6,0x79,0x7f,0xf3,0xbc,0xef,0xfb,0xbc,0x33,0xef,0x92,0x93,0x93,0x93,0x93,0x93,0x93,
  0x93,0x93,0xd3,0x10,0xeb,0xd0,0xd7,0xc6,0xf6,0x4d,0x71,0x0b,0x3e,0xc7,0xb7,0x18,0x44,0xd4,0x66,0xf6,
  0x4d,0xb1,0x0e,0x9f,0xa1,0x5c,0xf9,0x1d,0xc4,0x25,0x6d,0x64,0x3f,0x4f,0xa1,0x11,0x23,0xf4,0xa0,0x3f,
  0xb6,0x7f,0x7e,0xe5,0xd7,0x2e,0xf6,0xf3,0x34,0x2a,0x00,0x41,0xf9,0xa4,0xed,0x76,0xb1,0x47,0x73,0x02,
  0x9c,0x13,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,
  0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,
  0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,0x40,0xda,0xe4,0x02,0xa4,0xed,
  0x40,0xda,0x14,0xd3,0x76,0xa0,0x9a,0xbe,0x91,0x13,0x0b,0xf6,0x8f,0x6d,0xeb,0x59,0xd1,0xfb,0x65,0x2a,
  0x02,0xa2,0x62,0x07,0xac,0x8e,0x1f,0xab,0x16,0xa4,0xd5,0x64,0x4a,0x80,0x35,0x37,0x6e,0x87,0xeb,0xb1,
  0x0b,0x97,0xcf,0x1d,0xef,0x1b,0x39,0xb1,0x62,0x42,0x64,0x4a,0x80,0x72,0x69,0x16,0x8e,0xe0,0x5e,0xec,
  0xc1,0xc3,0x62,0x9f,0xbc,0x56,0x42,0x84,0x4c,0x09,0x70,0x7a,0xff,0x47,0x84,0xef,0x7c,0xdf,0x09,0x11,
  0xf0,0x38,0x3e,0xc4,0x4e,0xac,0x87,0x35,0x37,0xed,0x68,0xe9,0x3d,0x33,0x25,0xc0,0xcc,0xc4,0xf7,0x30,
  0x89,0xb1,0xd8,0xe1,0xab,0xf0,0x24,0x3e,0xc0,0x8e,0xee,0xc1,0xe1,0x7e,0xcc,0xb6,0xea,0x9e,0x99,0x12,
  0x40,0xb9,0x34,0xb7,0x35,0x86,0xa9,0xaa,0xd2,0x01,0x0c,0x97,0x4e,0x4e,0xbe,0xdf,0xbb,0x7b,0xec,0x9e,
  0x42,0x6f,0x7f,0x67,0x2b,0x6e,0x99,0x2d,0x01,0xce,0xb0,0x1f,0xbf,0x26,0x96,0x94,0x4b,0x1b,0x8a,0x17,
  0x0d,0x3c,0xd4,0xb3,0xfd,0xcd,0x0b,0x3a,0x6f,0xd8,0xa6,0xd0,0x3d,0xbf,0x3e,0xa2,0xcc,0xf2,0xfb,0x89,
  0xcc,0xe5,0x01,0x15,0x0e,0xe3,0x2b,0x5c,0x99,0x58,0x1a,0x15,0x14,0x2f,0xdd,0x18,0x75,0xad,0xbf,0xda,
  0xcc,0xb5,0x5b,0x4c,0x8d,0xbd,0x56,0x28,0x1d,0x3f,0xb2,0xb6,0x63,0x60,0x33,0xce,0x88,0x50,0x4f,0x0e,
  0x91,0x55,0x01,0x66,0xb1,0x17,0x77,0xd6,0x3c,0xa3,0x34,0x1b,0x84,0xb8,0x62,0x93,0xae,0xcb,0x36,0x76,
  0x2b,0x97,0x86,0x15,0x8a,0x2f,0xe2,0x3d,0xfc,0x45,0x7d,0x42,0x64,0xb5,0x09,0xc0,0xa7,0x2a,0x15,0x59,
  0x94,0x20,0x44,0xa4,0x50,0xdc,0x84,0x11,0xbc,0x8b,0xbb,0x84,0x45,0x14,0x58,0x3c,0x8f,0xc8,0x9c,0x00,
  0xb1,0xa7,0xf5,0x33,0x7e,0x5c,0xa6,0x79,0x11,0xd7,0xe1,0x55,0xbc,0x8d,0xdb,0xd1,0x35,0x57,0x98,0x24,
  0x42,0xe6,0x04,0x88,0x71,0x5c,0x88,0x82,0x46,0xe8,0xc0,0x66,0xbc,0x8e,0x77,0x70,0xb3,0x1a,0xcd,0x3d,
  0xcb,0x02,0xc0,0x28,0x4e,0x37,0x68,0xfb,0x27,0xbe,0xc0,0x01,0x4c,0xab,0xb1,0x8a,0x2c,0xab,0x9d,0xe0,
  0x1c,0xdf,0xe0,0x77,0xf5,0xad,0x00,0x2b,0x63,0x5c,0x58,0x3a,0x37,0x8a,0x7d,0xf8,0x09,0x8b,0x8e,0x8b,
  0x99,0x8c,0x80,0x58,0x3f,0xf0,0x9b,0xb0,0x0e,0xb0,0x1e,0x22,0xbc,0x85,0x2d,0x78,0x5e,0x18,0x46,0x17,
  0x54,0x3e,0x69,0x34,0x68,0x26,0x02,0xa2,0x1a,0xdb,0xad,0xb4,0x9f,0x16,0x86,0xc3,0x5b,0xeb,0xbc,0xe6,
  0x56,0x7c,0x22,0xcc,0x1f,0xb0,0x74,0x2e,0xd0,0x68,0x04,0x4c,0xe2,0xef,0xd8,0xfe,0x3f,0x42,0xa7,0xb5,
  0x12,0xf6,0xfb,0x2a,0xe5,0xf5,0xd0,0x87,0xa7,0xd4,0x4a,0xa0,0x12,0x68,0x54,0x80,0x63,0x78,0x16,0xbf,
  0x60,0x02,0xcf,0xe1,0x50,0x2b,0xed,0x63,0x4f,0xee,0x07,0x61,0x86,0x18,0xa7,0x54,0x9e,0x3e,0xb5,0x57,
  0x69,0x36,0x29,0x4f,0xb8,0x06,0x43,0xe8,0x66,0xe9,0xd4,0xb8,0x99,0xf5,0xb5,0x11,0x2e,0x16,0x9a,0xd1,
  0x21,0xcb,0x9f,0xa1,0x2d,0x69,0x1f,0x73,0xfe,0x65,0xdc,0x1d,0x2b,0xda,0x53,0x9e,0x3e,0x35,0x18,0xad,
  0xea,0xdc,0x2a,0x8a,0x86,0x70,0x5e,0x95,0x69,0x49,0x78,0xa9,0x32,0xa4,0x32,0x47,0xa8,0xd5,0x14,0x9a,
  0x5d,0x29,0x3a,0x2e,0x3c,0x9d,0x46,0xa6,0xa7,0xcb,0xb1,0x1f,0x15,0x2a,0x45,0x48,0x8e,0x1e,0x8c,0x56,
  0xad,0x3e,0x2c,0x8a,0x5e,0xc0,0x1b,0x09,0xe7,0x17,0x70,0x3f,0x6e,0x5b,0xca,0x89,0x4c,0x8e,0x02,0x09,
  0x7c,0x89,0xa3,0x42,0x3f,0xb1,0x13,0x07,0x44,0x05,0x38,0x89,0x47,0xf0,0x75,0x82,0x4d,0x2f,0x1e,0xc5,
  0x85,0x8b,0x5d,0x38,0xd3,0x02,0xc4,0xc2,0x76,0x5c,0x18,0xd6,0x9e,0x16,0x72,0xfd,0x38,0x07,0x05,0x51,
  0x8e,0x56,0x1d,0x9f,0xc0,0x2b,0x42,0x42,0x54,0x93,0x4c,0x0b,0x10,0x63,0x0a,0xbb,0x85,0xf1,0x1d,0x67,
  0xb5,0xe9,0x8f,0xf1,0x04,0x66,0x2a,0xfb,0xa3,0xb8,0x03,0x2f,0x39,0xfb,0xc5,0xca,0x02,0xfe,0xd7,0x3f,
  0x19,0x34,0x42,0x52,0x2f,0x1e,0xaf,0x7c,0xac,0x7c,0x2d,0x9e,0x11,0xfa,0x8a,0xc7,0xf0,0x47,0xd2,0xf9,
  0xd5,0xb4,0x4b,0x04,0xd4,0x24,0x56,0xb9,0x7f,0xf1,0x00,0xee,0x53,0x67,0xe5,0x69,0x83,0x08,0xa8,0x87,
  0x5a,0x63,0xfd,0x4a,0x7f,0x55,0xca,0x39,0x17,0xf8,0x0f,0xdd,0xdc,0xfc,0x04,0x66,0xb8,0x23,0x8e,0x00,
  0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
};

template<class T> T presentationFunction(HMODULE module, const char* name) {
  const auto address = GetProcAddress(module, name);
  require(address != nullptr);
  T result = nullptr;
  static_assert(sizeof(result) == sizeof(address));
  std::memcpy(&result, &address, sizeof(result));
  return result;
}
DWORD directParent() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.value != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  require(Process32FirstW(snapshot.value, &entry) != FALSE);
  do { if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID; }
  while (Process32NextW(snapshot.value, &entry));
  throw Failure{};
}
bool samePresentationUser(HANDLE parent) {
  HANDLE rawCurrent = nullptr, rawParent = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawCurrent) != FALSE);
  Handle currentToken(rawCurrent);
  require(OpenProcessToken(parent, TOKEN_QUERY, &rawParent) != FALSE);
  Handle parentToken(rawParent);
  auto user = [](HANDLE token, Bytes& bytes) {
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    require(size > 0 && size < 65536); bytes.value.resize(size);
    require(GetTokenInformation(token, TokenUser, bytes.value.data(), size, &size) != FALSE);
    return reinterpret_cast<TOKEN_USER*>(bytes.value.data())->User.Sid;
  };
  Bytes currentUser, parentUser;
  return EqualSid(user(currentToken.value, currentUser), user(parentToken.value, parentUser)) != FALSE;
}
bool exclusiveParentConsole(DWORD parent) {
  DWORD processes[3]{};
  const DWORD count = GetConsoleProcessList(processes, 3);
  return count == 2 && ((processes[0] == parent && processes[1] == GetCurrentProcessId())
    || (processes[1] == parent && processes[0] == GetCurrentProcessId()));
}
void presentationSkipped(std::string_view reason) {
  write("{\"schemaVersion\":1,\"state\":\"skipped\",\"reason\":\"");
  write(reason); write("\"}\n");
}
int assistantConsoleIcon() {
  // This closed CLI mode never enters private readiness/request processing.
  // Import user32 only here: ordinary ACL/DPAPI startup does not initialize GUI
  // DLLs or inherit a second deadline. No HWND/PID/image is accepted as input.
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE);
  require(GetFileType(input) == FILE_TYPE_PIPE && GetFileType(output) == FILE_TYPE_PIPE);
  const DWORD parentId = directParent();
  Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parentId));
  if (parent.value == nullptr || !samePresentationUser(parent.value)) {
    presentationSkipped("parent_identity_unavailable"); return 0;
  }
  // Keep a live handle and reject PID reuse after our own creation; a stale
  // parent number must never select a later same-user Node console.
  FILETIME parentCreated{}, parentExited{}, parentKernel{}, parentUserTime{};
  FILETIME selfCreated{}, selfExited{}, selfKernel{}, selfUserTime{};
  require(GetProcessTimes(parent.value, &parentCreated, &parentExited, &parentKernel, &parentUserTime) != FALSE);
  require(GetProcessTimes(GetCurrentProcess(), &selfCreated, &selfExited, &selfKernel, &selfUserTime) != FALSE);
  require(CompareFileTime(&parentCreated, &selfCreated) <= 0);
  wchar_t image[32768]{}; DWORD imageLength = 32768;
  require(QueryFullProcessImageNameW(parent.value, 0, image, &imageLength) != FALSE);
  const wchar_t* basename = wcsrchr(image, L'\\');
  if (!basename || _wcsicmp(basename + 1, L"node.exe") != 0) {
    presentationSkipped("parent_identity_unavailable"); return 0;
  }
  // CREATE_NO_WINDOW can associate this helper with a headless console while
  // GetConsoleWindow() is NULL. HWND absence is not a detach precondition:
  // FreeConsole succeeds even when unattached and affects ONLY this helper.
  // Then attach ONLY to its own direct parent; never allocate/show a console,
  // enumerate windows or select another process/window.
  require(FreeConsole() != FALSE);
  const BOOL attached = AttachConsole(ATTACH_PARENT_PROCESS);
  // Capture the API result before restoring std handles: that restoration may
  // change last-error. Closed reasons distinguish a missing parent console from
  // our already-associated console without exporting IDs, handles or raw errors.
  const DWORD attachError = attached ? ERROR_SUCCESS : GetLastError();
  // AttachConsole may replace standard handles; keep the inherited private
  // control pipes. No CONIN$/CONOUT$ stream is opened or written.
  SetStdHandle(STD_INPUT_HANDLE, input); SetStdHandle(STD_OUTPUT_HANDLE, output);
  if (!attached) {
    presentationSkipped(attachError == ERROR_ACCESS_DENIED ? "console_already_attached"
      : attachError == ERROR_INVALID_HANDLE ? "no_console"
      : attachError == ERROR_INVALID_PARAMETER ? "parent_identity_unavailable" : "console_attach_failed");
    return 0;
  }
  const auto window = GetConsoleWindow();
  const HMODULE user32 = LoadLibraryExW(L"user32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  require(user32 != nullptr);
  const auto visible = presentationFunction<decltype(&IsWindowVisible)>(user32, "IsWindowVisible");
  const auto className = presentationFunction<decltype(&GetClassNameW)>(user32, "GetClassNameW");
  const auto send = presentationFunction<decltype(&SendMessageTimeoutW)>(user32, "SendMessageTimeoutW");
  const auto foreground = presentationFunction<decltype(&GetForegroundWindow)>(user32, "GetForegroundWindow");
  const auto create = presentationFunction<decltype(&CreateIconFromResourceEx)>(user32, "CreateIconFromResourceEx");
  const auto destroy = presentationFunction<decltype(&DestroyIcon)>(user32, "DestroyIcon");
  const auto metrics = presentationFunction<decltype(&GetSystemMetrics)>(user32, "GetSystemMetrics");
  wchar_t name[64]{};
  if (!window || !visible(window) || className(window, name, 64) <= 0 || wcscmp(name, L"ConsoleWindowClass") != 0) {
    presentationSkipped("not_visible_classic_console"); FreeLibrary(user32); return 0;
  }
  if (!exclusiveParentConsole(parentId)) {
    presentationSkipped("shared_console"); FreeLibrary(user32); return 0;
  }
  const auto before = foreground();
  HICON smallIcon = create(AssistantConsoleIcon, static_cast<DWORD>(sizeof(AssistantConsoleIcon)), TRUE, 0x00030000,
    metrics(SM_CXSMICON), metrics(SM_CYSMICON), LR_DEFAULTCOLOR);
  HICON largeIcon = create(AssistantConsoleIcon, static_cast<DWORD>(sizeof(AssistantConsoleIcon)), TRUE, 0x00030000,
    metrics(SM_CXICON), metrics(SM_CYICON), LR_DEFAULTCOLOR);
  if (!smallIcon || !largeIcon) { if (smallIcon) destroy(smallIcon); if (largeIcon) destroy(largeIcon); FreeLibrary(user32); throw Failure{}; }
  DWORD_PTR oldSmall = 0, oldLarge = 0, gotSmall = 0, gotLarge = 0;
  auto message = [&](UINT type, WPARAM kind, LPARAM value, DWORD_PTR& result) {
    return send(window, type, kind, value, SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, &result) != 0;
  };
  const bool stillOwned = exclusiveParentConsole(parentId) && WaitForSingleObject(parent.value, 0) == WAIT_TIMEOUT;
  const bool smallSet = stillOwned && message(WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(smallIcon), oldSmall);
  const bool largeSet = smallSet && message(WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(largeIcon), oldLarge);
  const bool verified = largeSet && message(WM_GETICON, ICON_SMALL, 0, gotSmall)
    && message(WM_GETICON, ICON_BIG, 0, gotLarge)
    && gotSmall == reinterpret_cast<DWORD_PTR>(smallIcon) && gotLarge == reinterpret_cast<DWORD_PTR>(largeIcon);
  if (verified) {
    write(before == foreground() ? "{\"schemaVersion\":1,\"state\":\"applied\",\"verified\":true,\"foregroundUnchanged\":true}\n"
      : "{\"schemaVersion\":1,\"state\":\"applied\",\"verified\":true,\"foregroundUnchanged\":false}\n");
    // HICON belongs to this process. Retain it for exactly this supervisor's
    // pipe lifetime; no timer/poll/private worker is kept alive for branding.
    BYTE unused = 0; DWORD count = 0;
    ReadFile(input, &unused, 1, &count, nullptr);
  }
  // Restore only handles still owned by this presentation attempt, never a
  // later icon installed by somebody else. No window activation/show occurs.
  if (smallSet && message(WM_GETICON, ICON_SMALL, 0, gotSmall) && gotSmall == reinterpret_cast<DWORD_PTR>(smallIcon)) {
    DWORD_PTR ignored = 0; message(WM_SETICON, ICON_SMALL, static_cast<LPARAM>(oldSmall), ignored);
  }
  if (largeSet && message(WM_GETICON, ICON_BIG, 0, gotLarge) && gotLarge == reinterpret_cast<DWORD_PTR>(largeIcon)) {
    DWORD_PTR ignored = 0; message(WM_SETICON, ICON_BIG, static_cast<LPARAM>(oldLarge), ignored);
  }
  destroy(smallIcon); destroy(largeIcon); FreeLibrary(user32);
  if (!verified) throw Failure{};
  return 0;
}

// Fixed PUBLIC metadata query, separate from readiness/private requests and
// console presentation. AppModel selects only this user's registered Codex
// main package. Ambiguity during an update is unavailable, never "newest".
// The returned path is data: this mode never launches, copies or changes it.
std::wstring currentCodexPackagePath() {
  constexpr PCWSTR family = L"OpenAI.Codex_2p2nqsd0c76g0";
  UINT32 count = 0, length = 0;
  LONG status = FindPackagesByPackageFamily(family, PACKAGE_FILTER_HEAD,
    &count, nullptr, &length, nullptr, nullptr);
  if (status == ERROR_SUCCESS && count == 0) {
    return {};
  }
  require(status == ERROR_INSUFFICIENT_BUFFER && count == 1 && length > 0 && length < 32768);
  std::vector<PWSTR> names(count);
  std::vector<WCHAR> buffer(length);
  std::vector<UINT32> properties(count);
  require(FindPackagesByPackageFamily(family, PACKAGE_FILTER_HEAD, &count,
    names.data(), &length, buffer.data(), properties.data()) == ERROR_SUCCESS && count == 1);
  require(!(properties[0] & (PACKAGE_PROPERTY_FRAMEWORK | PACKAGE_PROPERTY_RESOURCE |
    PACKAGE_PROPERTY_BUNDLE | PACKAGE_PROPERTY_DEVELOPMENT_MODE)));
  UINT32 pathLength = 0;
  require(GetPackagePathByFullName(names[0], &pathLength, nullptr) == ERROR_INSUFFICIENT_BUFFER
    && pathLength > 1 && pathLength < 32768);
  std::vector<WCHAR> packagePath(pathLength);
  require(GetPackagePathByFullName(names[0], &pathLength, packagePath.data()) == ERROR_SUCCESS);
  return std::wstring(packagePath.data());
}
int codexPackagePath() {
  const auto packagePath = currentCodexPackagePath();
  if (packagePath.empty()) { write("{\"schemaVersion\":1,\"state\":\"unavailable\"}\n"); return 0; }
  int utf8Length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, packagePath.c_str(),
    -1, nullptr, 0, nullptr, nullptr);
  require(utf8Length > 1 && utf8Length < 16384);
  Text utf8;
  utf8.value.resize(static_cast<size_t>(utf8Length));
  require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, packagePath.c_str(), -1,
    utf8.value.data(), utf8Length, nullptr, nullptr) == utf8Length);
  Text encoded;
  encode(reinterpret_cast<const BYTE*>(utf8.value.data()), static_cast<DWORD>(utf8Length - 1), encoded);
  write("{\"schemaVersion\":1,\"state\":\"available\",\"pathBase64\":\"");
  write(encoded.value); write("\"}\n"); return 0;
}

struct DesktopIdentity { DWORD pid; FILETIME created; };
std::optional<DesktopIdentity> currentCodexDesktop() {
  const auto root=currentCodexPackagePath();require(!root.empty());
  DWORD session=0;require(ProcessIdToSessionId(GetCurrentProcessId(),&session)!=FALSE);
  struct Item { DWORD pid,parent;FILETIME created;HANDLE handle; };
  struct Items { std::vector<Item> values;~Items(){for(const auto& item:values)CloseHandle(item.handle);} } items;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));require(snapshot.value!=INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);require(Process32FirstW(snapshot.value,&entry)!=FALSE);
  do {
    if(_wcsicmp(entry.szExeFile,L"ChatGPT.exe")!=0 && _wcsicmp(entry.szExeFile,L"Codex.exe")!=0)continue;
    DWORD targetSession=0;
    if(!ProcessIdToSessionId(entry.th32ProcessID,&targetSession)){require(GetLastError()==ERROR_INVALID_PARAMETER);continue;}
    if(targetSession!=session)continue;
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,entry.th32ProcessID));
    if(!process.value){require(GetLastError()==ERROR_INVALID_PARAMETER);continue;}
    if(WaitForSingleObject(process.value,0)==WAIT_OBJECT_0)continue;
    wchar_t image[32768]{};DWORD length=32768;
    require(QueryFullProcessImageNameW(process.value,0,image,&length)!=FALSE);
    if(_wcsicmp(image,(root+L"\\app\\ChatGPT.exe").c_str())!=0
      && _wcsicmp(image,(root+L"\\app\\Codex.exe").c_str())!=0)continue;
    if(!samePresentationUser(process.value))continue;
    FILETIME created{},exited{},kernel{},user{};
    require(GetProcessTimes(process.value,&created,&exited,&kernel,&user)!=FALSE);
    require(items.values.size()<256);
    items.values.push_back({entry.th32ProcessID,entry.th32ParentProcessID,created,process.value});process.value=nullptr;
  }while(Process32NextW(snapshot.value,&entry));
  require(GetLastError()==ERROR_NO_MORE_FILES);
  std::optional<DesktopIdentity> selected;
  for(const auto& item:items.values){
    bool child=false;
    for(const auto& other:items.values)if(other.pid==item.parent && CompareFileTime(&other.created,&item.created)<=0){child=true;break;}
    if(child)continue;
    // Electron renderers share the executable. The one application root is the
    // process whose original parent is outside this exact package/user/session
    // tree. Keep all handles through selection; parent creation time excludes
    // PID reuse. A tray-hidden root is still running, never a stopped GUI.
    require(!selected.has_value());selected=DesktopIdentity{item.pid,item.created};
  }
  require(items.values.empty()||selected.has_value());return selected;
}
int inspectCodexDesktop(){
  const auto current=currentCodexDesktop();
  if(!current){write("{\"schemaVersion\":1,\"state\":\"stopped\",\"generation\":null}\n");return 0;}
  ULARGE_INTEGER time{};time.LowPart=current->created.dwLowDateTime;time.HighPart=current->created.dwHighDateTime;
  write("{\"schemaVersion\":1,\"state\":\"running\",\"generation\":\"");
  write(std::to_string(current->pid));write(":");write(std::to_string(time.QuadPart+504911232000000000ULL));write("\"}\n");return 0;
}

// Closing a window can leave the Electron application in the system tray.
// Restart Manager's NORMAL shutdown asks the exact application to exit, including
// its normal cleanup; there is deliberately no force flag/TerminateProcess.
// This public maintenance mode is separate from private ACL/DPAPI startup.
int closeCodexDesktop(std::string_view generation) {
  const auto colon = generation.find(':');
  require(colon != std::string_view::npos && generation.find(':', colon + 1) == std::string_view::npos);
  const auto number = [](std::string_view value) {
    require(!value.empty() && value.size() <= 20 && value.front() != '0');
    uint64_t result = 0;
    for (const char c : value) {
      require(c >= '0' && c <= '9' && result <= (std::numeric_limits<uint64_t>::max() - (c-'0')) / 10);
      result = result * 10 + (c-'0');
    }
    return result;
  };
  const uint64_t pid = number(generation.substr(0,colon)), ticks = number(generation.substr(colon+1));
  require(pid <= std::numeric_limits<DWORD>::max());
  const auto packageRoot = currentCodexPackagePath(); require(!packageRoot.empty());
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(pid)));
  if (!process.value && GetLastError() == ERROR_INVALID_PARAMETER) {
    write("{\"schemaVersion\":1,\"state\":\"stopped\",\"generation\":null}\n"); return 0;
  }
  require(process.value && samePresentationUser(process.value));
  const auto app=currentCodexDesktop();require(app.has_value() && app->pid==pid);
  DWORD ownSession=0,targetSession=0;
  require(ProcessIdToSessionId(GetCurrentProcessId(),&ownSession) && ProcessIdToSessionId(static_cast<DWORD>(pid),&targetSession)
    && ownSession==targetSession);
  FILETIME created{},exited{},kernel{},user{};
  require(GetProcessTimes(process.value,&created,&exited,&kernel,&user));
  ULARGE_INTEGER fileTime{}; fileTime.LowPart=created.dwLowDateTime; fileTime.HighPart=created.dwHighDateTime;
  // .NET Process.StartTime uses the year-0001 epoch; Win32 FILETIME uses 1601.
  require(ticks >= 504911232000000000ULL && fileTime.QuadPart == ticks-504911232000000000ULL);
  wchar_t image[32768]{}; DWORD length=32768;
  require(QueryFullProcessImageNameW(process.value,0,image,&length));
  require(_wcsicmp(image,(packageRoot+L"\\app\\ChatGPT.exe").c_str())==0
    || _wcsicmp(image,(packageRoot+L"\\app\\Codex.exe").c_str())==0);
  // Load only the system DLL after all owner/session/package/generation checks.
  // Register ONE process, not a file/service: unrelated applications cannot be
  // pulled into the resource list. The original handle also excludes PID reuse.
  HMODULE library=LoadLibraryExW(L"rstrtmgr.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);require(library);
  try {
    const auto start=presentationFunction<decltype(&RmStartSession)>(library,"RmStartSession");
    const auto add=presentationFunction<decltype(&RmRegisterResources)>(library,"RmRegisterResources");
    const auto list=presentationFunction<decltype(&RmGetList)>(library,"RmGetList");
    const auto shutdown=presentationFunction<decltype(&RmShutdown)>(library,"RmShutdown");
    const auto end=presentationFunction<decltype(&RmEndSession)>(library,"RmEndSession");
    DWORD session=0;WCHAR key[CCH_RM_SESSION_KEY+1]{};require(start(&session,0,key)==ERROR_SUCCESS);
    try {
      RM_UNIQUE_PROCESS target{static_cast<DWORD>(pid),created};
      require(add(session,0,nullptr,1,&target,0,nullptr)==ERROR_SUCCESS);
      UINT needed=0,count=1;DWORD reboot=0;RM_PROCESS_INFO info{};
      require(list(session,&needed,&count,&info,&reboot)==ERROR_SUCCESS && count==1 && reboot==0
        && info.Process.dwProcessId==target.dwProcessId && CompareFileTime(&info.Process.ProcessStartTime,&created)==0);
      require(shutdown(session,0,nullptr)==ERROR_SUCCESS); // NORMAL, never RmForceShutdown
      require(WaitForSingleObject(process.value,15000)==WAIT_OBJECT_0);
    } catch (...) { end(session);throw; }
    require(end(session)==ERROR_SUCCESS);
  } catch (...) { FreeLibrary(library);throw; }
  FreeLibrary(library);
  write("{\"schemaVersion\":1,\"state\":\"stopped\",\"generation\":null}\n");return 0;
}

int main(int argc, char* argv[]) {
  if (argc != 1) {
    if (argc == 3 && std::string_view(argv[1]) == "--codex-desktop-close") {
      try { return closeCodexDesktop(argv[2]); }
      catch (...) { try { write("{\"schemaVersion\":1,\"state\":\"unavailable\",\"generation\":null}\n"); } catch (...) {} return 1; }
    }
    if (argc != 2) return 1;
    if (std::string_view(argv[1]) == "--codex-desktop-inspect") {
      try { return inspectCodexDesktop(); }
      catch (...) { try { write("{\"schemaVersion\":1,\"state\":\"unavailable\",\"generation\":null}\n"); } catch (...) {} return 1; }
    }
    if (std::string_view(argv[1]) == "--codex-package-path") {
      try { return codexPackagePath(); }
      catch (...) { try { write("{\"schemaVersion\":1,\"state\":\"unavailable\"}\n"); } catch (...) {} return 0; }
    }
    if (std::string_view(argv[1]) != "--assistant-console-icon") return 1;
    try { return assistantConsoleIcon(); }
    catch (...) { try { write("{\"schemaVersion\":1,\"state\":\"unavailable\"}\n"); } catch (...) {} return 1; }
  }
  try {
    // Readiness does not query the token, touch private state, change ACLs or
    // call DPAPI. Doctor closes stdin here, before the first operation.
    write("{\"ready\":true}\n");
    Text line;
    // Reserve the bound once so growth cannot leave old plaintext allocations.
    line.value.reserve(MaxLine);
    Bytes chunk(4096);
    for (;;) {
      DWORD count = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), chunk.value.data(),
          static_cast<DWORD>(chunk.value.size()), &count, nullptr)) {
        require(GetLastError() == ERROR_BROKEN_PIPE); break;
      }
      if (!count) break;
      for (DWORD i = 0; i < count; ++i) {
        char c = static_cast<char>(chunk.value[i]);
        if (c == '\n') {
          request(line.value);
          SecureZeroMemory(line.value.data(), line.value.size()); line.value.clear();
        } else {
          require(line.value.size() < MaxLine && c != '\r' && c != '\0');
          line.value.push_back(c);
        }
      }
      SecureZeroMemory(chunk.value.data(), chunk.value.size());
    }
    require(line.value.empty());
    return 0;
  } catch (...) { return 1; }
}
