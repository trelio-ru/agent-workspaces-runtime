// SOURCE-TREE-ONLY: contain one synthetic Codex invocation and its descendants.
// The real CLI and RPC streams remain unchanged. Windows can retain a fixture
// cwd in a descendant after the App Server's own close event; a private Job
// Object gives this test a kernel-owned lifetime instead of a PID/tree scan.
#include <windows.h>
#include <string>

namespace {
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

// Match CommandLineToArgvW/CRT quoting, including quotes and trailing slashes.
// No shell interprets the synthetic CLI arguments and nothing is logged.
std::wstring quote(const std::wstring& input) {
  std::wstring output = L"\"";
  size_t slashes = 0;
  for (wchar_t character : input) {
    if (character == L'\\') { ++slashes; continue; }
    if (character == L'\"') output.append(slashes * 2 + 1, L'\\');
    else output.append(slashes, L'\\');
    slashes = 0;
    output += character;
  }
  output.append(slashes * 2, L'\\');
  return output + L'\"';
}
}

int wmain(int argc, wchar_t** argv) {
  constexpr int failure = 73;
  if (argc < 2) return failure;
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) return failure;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
      &limits, sizeof(limits))) return failure;
  std::wstring command;
  for (int index = 1; index < argc; ++index) {
    if (!command.empty()) command += L' ';
    command += quote(argv[index]);
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  // Assign BEFORE executing any child instruction. An assignment failure can
  // terminate only this retained suspended handle, never another process.
  if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      nullptr, nullptr, &startup, &process)) return failure;
  Handle child(process.hProcess), thread(process.hThread);
  if (!AssignProcessToJobObject(job.value, child.value)) {
    TerminateProcess(child.value, failure);
    WaitForSingleObject(child.value, INFINITE);
    return failure;
  }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return failure;
  if (WaitForSingleObject(child.value, INFINITE) != WAIT_OBJECT_0) return failure;
  DWORD exitCode = failure;
  if (!GetExitCodeProcess(child.value, &exitCode)) return failure;
  if (!TerminateJobObject(job.value, 0)) return failure;
  // Native parent exit alone is insufficient. Do not publish our close while
  // an owned descendant still holds the temporary cwd or inherited RPC pipes.
  // The existing Node fixture deadline bounds this owner too; killing this
  // owner closes the non-inheritable job handle and terminates only its tree.
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
        &accounting, sizeof(accounting), nullptr)) return failure;
    if (accounting.ActiveProcesses == 0) break;
    Sleep(1);
  }
  return static_cast<int>(exitCode);
}
