// Windows private-state transport. No PowerShell, CLR, profiles or module
// loader participate in startup. All requests arrive over anonymous pipes;
// stdout contains only the bounded protocol and stderr is never used.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <wincrypt.h>
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

int main() {
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
