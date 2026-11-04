// SOURCE-TREE-ONLY fixture. This executable is never part of a signed package.
// Include the production primitives so a green test cannot merely demonstrate
// an independently implemented SCM/RM workaround. The public production main
// retains its fixed selectors; only this disposable fixture has test commands.
#define main trelioPrivateProcessMain
#include "../../host-runtime/scripts/native-private-process/PrivateProcess.cpp"
#undef main
#include <sddl.h>
#include <wbemidl.h>
#include <utility>

namespace {
constexpr PCWSTR FixtureService=L"TrelioDisposablePackageServiceAccess";
SERVICE_STATUS_HANDLE fixtureStatus=nullptr;
HANDLE fixtureStop=nullptr;
const char* fixtureStage="arguments";
std::wstring fixtureExecutable() {
  wchar_t value[32768]{};const auto size=GetModuleFileNameW(nullptr,value,32768);
  require(size>0&&size<32768);std::wstring image(value,size);
  const auto slash=image.find_last_of(L"\\/");require(slash!=std::wstring::npos);
  // The client is a separate file. Executing the service image as the test
  // client would itself keep that FILE resource in use and invalidate the
  // exact production one-service inventory this fixture is meant to exercise.
  if(image.substr(slash+1)==L"fixture-controller.exe")
    return image.substr(0,slash)+L"\\app\\resources\\codex-windows-sandbox-service.exe";
  return image;
}
std::wstring fixtureRoot() {
  auto value=fixtureExecutable();
  for(int i=0;i<3;++i){const auto slash=value.find_last_of(L"\\/");require(slash!=std::wstring::npos);value.resize(slash);}
  require(_wcsicmp(fixtureExecutable().c_str(),(value+L"\\app\\resources\\codex-windows-sandbox-service.exe").c_str())==0);
  return value;
}
bool administrator() {
  SID_IDENTIFIER_AUTHORITY authority=SECURITY_NT_AUTHORITY;PSID sid=nullptr;
  require(AllocateAndInitializeSid(&authority,2,SECURITY_BUILTIN_DOMAIN_RID,
    DOMAIN_ALIAS_RID_ADMINS,0,0,0,0,0,0,&sid)!=FALSE);
  BOOL member=FALSE;const auto result=CheckTokenMembership(nullptr,sid,&member);FreeSid(sid);
  require(result!=FALSE);return member!=FALSE;
}
void fixtureReport(DWORD state,DWORD accepted=0) {
  SERVICE_STATUS status{};status.dwServiceType=SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState=state;status.dwControlsAccepted=accepted;
  require(SetServiceStatus(fixtureStatus,&status)!=FALSE);
}
void WINAPI fixtureControl(DWORD control) {
  if(control==SERVICE_CONTROL_STOP){
    SERVICE_STATUS status{};status.dwServiceType=SERVICE_WIN32_OWN_PROCESS;status.dwCurrentState=SERVICE_STOP_PENDING;
    SetServiceStatus(fixtureStatus,&status);SetEvent(fixtureStop);
  }
}
void WINAPI fixtureServiceMain(DWORD,LPWSTR*) {
  try {
    fixtureStatus=RegisterServiceCtrlHandlerW(FixtureService,fixtureControl);require(fixtureStatus);
    Handle stopped(CreateEventW(nullptr,TRUE,FALSE,nullptr));require(stopped.value);fixtureStop=stopped.value;
    // Reproduce the production boundary: LocalSystem owns its process; the
    // standard account has NO process-query/synchronization grant. SCM control
    // is granted independently below. No actual Codex process/ACL is touched.
    Local descriptor;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"D:P(A;;GA;;;SY)(A;;0x1400;;;BA)",SDDL_REVISION_1,&descriptor.value,nullptr)!=FALSE);
    require(SetKernelObjectSecurity(GetCurrentProcess(),DACL_SECURITY_INFORMATION,descriptor.value)!=FALSE);
    fixtureReport(SERVICE_RUNNING,SERVICE_ACCEPT_STOP);
    require(WaitForSingleObject(stopped.value,INFINITE)==WAIT_OBJECT_0);
    fixtureReport(SERVICE_STOPPED);fixtureStop=nullptr;
  }catch(...){if(fixtureStatus){SERVICE_STATUS value{};value.dwServiceType=SERVICE_WIN32_OWN_PROCESS;
    value.dwCurrentState=SERVICE_STOPPED;value.dwWin32ExitCode=ERROR_SERVICE_SPECIFIC_ERROR;value.dwServiceSpecificExitCode=1;
    SetServiceStatus(fixtureStatus,&value);}}
}
ServiceHandle fixtureManager(DWORD access) {
  return ServiceHandle(OpenSCManagerW(nullptr,nullptr,access));
}
void waitFixtureState(SC_HANDLE service,DWORD state) {
  const auto started=GetTickCount64();
  while(codexServiceStatus(service).dwCurrentState!=state){require(GetTickCount64()-started<10000);Sleep(50);}
}
struct FixtureBasicProcessRecord {
  bool available=false,complete=false,found=false,imageMatches=false;
  DWORD status=0;
  ULONG64 sequence=0;
};
FixtureBasicProcessRecord probeFixtureBasicProcess(DWORD selectedPid) {
  // SOURCE-ONLY comparison, NOT production admission. Microsoft documents
  // SystemBasicProcessInformation (Windows 11 26100.4770+) and its OS-assigned
  // SequenceNumber specifically for detecting PID reuse without process opens:
  // https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation
  // The published Microsoft winternl.h defines the information class as 252.
  // Copy only this documented layout, never reserved CreateTime offsets from
  // SYSTEM_PROCESS_INFORMATION. Older/unavailable APIs remain failed evidence.
  struct NativeString { USHORT length,maximum; PWSTR value; };
  struct NativeProcess { ULONG next; HANDLE pid,parent; ULONG64 sequence; NativeString image; };
  FixtureBasicProcessRecord result;
  const auto library=LoadLibraryExW(L"ntdll.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
  if(!library)return result;
  using Query=LONG(NTAPI*)(ULONG,PVOID,ULONG,PULONG);
  const auto address=GetProcAddress(library,"NtQuerySystemInformation");
  if(!address){FreeLibrary(library);return result;}
  Query query=nullptr;static_assert(sizeof(query)==sizeof(address));
  std::memcpy(&query,&address,sizeof(query));
  // One fixed bounded read, not a size-growth loop. Validate the COMPLETE
  // returned chain and every string before retaining only our fixture's row.
  // No process names, IDs or sequence values are printed by the diagnostic.
  std::vector<BYTE> bytes(4*1024*1024);ULONG used=0;
  result.available=true;result.status=static_cast<DWORD>(query(252,bytes.data(),static_cast<ULONG>(bytes.size()),&used));
  FreeLibrary(library);
  if(result.status!=0||used<sizeof(NativeProcess)||used>bytes.size())return result;
  size_t offset=0;bool found=false;ULONG64 sequence=0;bool imageMatches=false;
  const auto base=reinterpret_cast<ULONG_PTR>(bytes.data());
  while(true){
    if(offset>used||sizeof(NativeProcess)>used-offset)return result;
    NativeProcess entry{};std::memcpy(&entry,bytes.data()+offset,sizeof(entry));
    const auto text=reinterpret_cast<ULONG_PTR>(entry.image.value);
    if(entry.image.length>entry.image.maximum||entry.image.length%sizeof(wchar_t)!=0)return result;
    if(entry.image.length>0&&(text%alignof(wchar_t)!=0||text<base||text-base>used||entry.image.length>used-(text-base)))return result;
    if(reinterpret_cast<ULONG_PTR>(entry.pid)==selectedPid){
      if(found||entry.sequence==0||entry.image.length==0)return result;
      found=true;sequence=entry.sequence;
      const std::wstring image(entry.image.value,entry.image.length/sizeof(wchar_t));
      imageMatches=_wcsicmp(image.c_str(),L"codex-windows-sandbox-service.exe")==0;
    }
    if(entry.next==0)break;
    if(entry.next<sizeof(NativeProcess)||entry.next>used-offset)return result;
    offset+=entry.next;
  }
  result.complete=true;result.found=found;result.sequence=sequence;result.imageMatches=imageMatches;return result;
}
void prepareFixture() {
  require(administrator());auto manager=fixtureManager(SC_MANAGER_CONNECT|SC_MANAGER_CREATE_SERVICE);require(manager.value);
  const auto executable=L"\""+fixtureExecutable()+L"\"";
  // CreateService, not OpenOrCreate: never adopt or delete another fixture run.
  ServiceHandle service(CreateServiceW(manager.value,FixtureService,FixtureService,SERVICE_ALL_ACCESS,
    SERVICE_WIN32_OWN_PROCESS,SERVICE_DEMAND_START,SERVICE_ERROR_NORMAL,executable.c_str(),nullptr,nullptr,nullptr,nullptr,nullptr));
  require(service.value);verifyCodexServiceConfiguration(service.value,fixtureRoot());
  Local descriptor;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
    L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCRPWPLORC;;;AU)",SDDL_REVISION_1,&descriptor.value,nullptr)!=FALSE);
  require(SetServiceObjectSecurity(service.value,DACL_SECURITY_INFORMATION,descriptor.value)!=FALSE);
  require(StartServiceW(service.value,0,nullptr)!=FALSE);waitFixtureState(service.value,SERVICE_RUNNING);
  const auto status=codexServiceStatus(service.value);
  // Independent administrative reference, using ONLY the query right granted
  // to Administrators by this fixture's process DACL. The ordinary probe never
  // receives that handle/privilege; it must recover the same OS generation.
  Handle reference(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,status.dwProcessId));require(reference.value);
  FILETIME created{},exited{},kernel{},user{};require(GetProcessTimes(reference.value,&created,&exited,&kernel,&user));
  require(codexServiceStatus(service.value).dwProcessId==status.dwProcessId);
  ULARGE_INTEGER time{};time.LowPart=created.dwLowDateTime;time.HighPart=created.dwHighDateTime;
  const auto basic=probeFixtureBasicProcess(status.dwProcessId);
  require(codexServiceStatus(service.value).dwProcessId==status.dwProcessId);
  write("{\"prepared\":true,\"generation\":\"");write(std::to_string(status.dwProcessId));write(":");
  write(std::to_string(time.QuadPart+504911232000000000ULL));write("\",\"sequence\":");
  if(basic.complete&&basic.found&&basic.imageMatches){write("\"");write(std::to_string(basic.sequence));write("\"");}
  else {write("null");}
  write("}\n");
}

struct FixtureResourceRecord {
  DWORD opened=0,registered=0,listed=0,ended=0;
  std::optional<DWORD> count;
  bool pidMatches=false,nameMatches=false,typeMatches=false,generationMatches=false;
};
struct FixtureWmiRecord {
  DWORD stage=0,status=0;
  bool complete=false,pidMatches=false,nameMatches=false,pathAvailable=false,pathMatches=false;
  bool creationAvailable=false,creationMatchesMicroseconds=false;
};
std::optional<ULONGLONG> fixtureWmiCreation(BSTR value) {
  // DMTF CreationDate has SIX fractional digits, not FILETIME's seven. Keep
  // that loss explicit in this diagnostic; never claim exact 100ns identity
  // or silently substitute a rounded generation in production/legacy receipts.
  if(!value||SysStringLen(value)!=25||value[14]!=L'.'||(value[21]!=L'+'&&value[21]!=L'-'))return {};
  for(size_t i=0;i<25;++i)if(i!=14&&i!=21&&(value[i]<L'0'||value[i]>L'9'))return {};
  const auto number=[&](size_t offset,size_t count){DWORD result=0;
    for(size_t i=0;i<count;++i)result=result*10+static_cast<DWORD>(value[offset+i]-L'0');return result;};
  SYSTEMTIME date{};date.wYear=static_cast<WORD>(number(0,4));date.wMonth=static_cast<WORD>(number(4,2));
  date.wDay=static_cast<WORD>(number(6,2));date.wHour=static_cast<WORD>(number(8,2));
  date.wMinute=static_cast<WORD>(number(10,2));date.wSecond=static_cast<WORD>(number(12,2));
  FILETIME file{};if(!SystemTimeToFileTime(&date,&file))return {};
  ULARGE_INTEGER time{};time.LowPart=file.dwLowDateTime;time.HighPart=file.dwHighDateTime;
  const auto fraction=static_cast<ULONGLONG>(number(15,6))*10;
  const auto offset=static_cast<ULONGLONG>(number(22,3))*60*10000000;
  if(time.QuadPart>std::numeric_limits<ULONGLONG>::max()-fraction)return {};
  auto utc=time.QuadPart+fraction;
  if(value[21]==L'+'){if(utc<offset)return {};utc-=offset;}
  else {if(utc>std::numeric_limits<ULONGLONG>::max()-offset)return {};utc+=offset;}
  constexpr ULONGLONG epoch=504911232000000000ULL;
  if(utc>std::numeric_limits<ULONGLONG>::max()-epoch)return {};
  return utc+epoch;
}
template<class T> struct FixtureCom {
  T* value=nullptr;
  ~FixtureCom(){if(value)value->Release();}
};
struct FixtureBstr {
  BSTR value;
  explicit FixtureBstr(const wchar_t* text):value(SysAllocString(text)){require(value!=nullptr);}
  ~FixtureBstr(){SysFreeString(value);}
};
struct FixtureVariant {
  VARIANT value;
  FixtureVariant(){VariantInit(&value);}
  ~FixtureVariant(){VariantClear(&value);}
};
FixtureWmiRecord probeFixtureWmi(DWORD pid,const std::string& reference) {
  // SOURCE-ONLY old-Windows API comparison. Query only our exact inert service
  // process, using the SAME ordinary caller and no explicit credentials or
  // privilege adjustments. No WMI method/control endpoint exists in this code.
  // https://learn.microsoft.com/windows/win32/wmisdk/example--getting-wmi-data-from-the-local-computer
  FixtureWmiRecord result;result.stage=1;
  const auto initialized=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
  result.status=static_cast<DWORD>(initialized);if(FAILED(initialized))return result;
  struct Uninitialize {~Uninitialize(){CoUninitialize();}} uninitialize;
  result.stage=2;auto hr=CoInitializeSecurity(nullptr,-1,nullptr,nullptr,RPC_C_AUTHN_LEVEL_DEFAULT,
    RPC_C_IMP_LEVEL_IMPERSONATE,nullptr,EOAC_NONE,nullptr);
  result.status=static_cast<DWORD>(hr);if(FAILED(hr)&&hr!=RPC_E_TOO_LATE)return result;
  FixtureCom<IWbemLocator> locator;FixtureCom<IWbemServices> services;FixtureCom<IEnumWbemClassObject> rows;
  result.stage=3;hr=CoCreateInstance(CLSID_WbemLocator,nullptr,CLSCTX_INPROC_SERVER,IID_IWbemLocator,
    reinterpret_cast<void**>(&locator.value));result.status=static_cast<DWORD>(hr);if(FAILED(hr))return result;
  FixtureBstr space(L"ROOT\\CIMV2");result.stage=4;
  hr=locator.value->ConnectServer(space.value,nullptr,nullptr,nullptr,WBEM_FLAG_CONNECT_USE_MAX_WAIT,nullptr,nullptr,&services.value);
  result.status=static_cast<DWORD>(hr);if(FAILED(hr))return result;
  result.stage=5;hr=CoSetProxyBlanket(services.value,RPC_C_AUTHN_WINNT,RPC_C_AUTHZ_NONE,nullptr,
    RPC_C_AUTHN_LEVEL_CALL,RPC_C_IMP_LEVEL_IMPERSONATE,nullptr,EOAC_NONE);
  result.status=static_cast<DWORD>(hr);if(FAILED(hr))return result;
  const auto query=L"SELECT ProcessId,Name,ExecutablePath,CreationDate FROM Win32_Process WHERE ProcessId="+std::to_wstring(pid);
  FixtureBstr language(L"WQL"),statement(query.c_str());result.stage=6;
  hr=services.value->ExecQuery(language.value,statement.value,WBEM_FLAG_FORWARD_ONLY|WBEM_FLAG_RETURN_IMMEDIATELY,nullptr,&rows.value);
  result.status=static_cast<DWORD>(hr);if(FAILED(hr))return result;
  FixtureCom<IWbemClassObject> row,extra;ULONG count=0;result.stage=7;
  hr=rows.value->Next(5000,1,&row.value,&count);result.status=static_cast<DWORD>(hr);
  if(hr!=S_OK||count!=1||!row.value)return result;
  count=0;hr=rows.value->Next(5000,1,&extra.value,&count);result.status=static_cast<DWORD>(hr);
  if(hr!=S_FALSE||count!=0)return result;
  FixtureVariant id,name,path,created;result.stage=8;
  for(const auto& item:std::array<std::pair<PCWSTR,VARIANT*>,4>{{{L"ProcessId",&id.value},{L"Name",&name.value},
      {L"ExecutablePath",&path.value},{L"CreationDate",&created.value}}}){
    hr=row.value->Get(item.first,0,item.second,nullptr,nullptr);result.status=static_cast<DWORD>(hr);if(FAILED(hr))return result;
  }
  result.pidMatches=(id.value.vt==VT_I4&&id.value.lVal>0&&static_cast<DWORD>(id.value.lVal)==pid)
    ||(id.value.vt==VT_UI4&&id.value.ulVal==pid);
  result.nameMatches=name.value.vt==VT_BSTR&&name.value.bstrVal&&SysStringLen(name.value.bstrVal)<32768
    &&_wcsicmp(name.value.bstrVal,L"codex-windows-sandbox-service.exe")==0;
  result.pathAvailable=path.value.vt==VT_BSTR&&path.value.bstrVal&&SysStringLen(path.value.bstrVal)>0&&SysStringLen(path.value.bstrVal)<32768;
  result.pathMatches=result.pathAvailable&&_wcsicmp(path.value.bstrVal,fixtureExecutable().c_str())==0;
  const auto time=created.value.vt==VT_BSTR?fixtureWmiCreation(created.value.bstrVal):std::optional<ULONGLONG>{};
  result.creationAvailable=time.has_value();
  const auto colon=reference.find(':');require(colon!=std::string::npos&&reference.substr(0,colon)==std::to_string(pid));
  const auto original=std::stoull(reference.substr(colon+1));
  result.creationMatchesMicroseconds=time&&*time/10==original/10;
  result.stage=9;result.status=0;result.complete=true;return result;
}
FixtureResourceRecord probeFixtureResource(bool file,DWORD pid,const std::string& reference) {
  PackageServiceImage api(fixtureExecutable());FixtureResourceRecord result;
  DWORD session=0;WCHAR key[CCH_RM_SESSION_KEY+1]{};
  result.opened=api.start(&session,0,key);if(result.opened!=ERROR_SUCCESS)return result;
  LPCWSTR resource=file?api.executable.c_str():FixtureService;
  result.registered=file?api.add(session,1,&resource,0,nullptr,0,nullptr)
    :api.add(session,0,nullptr,0,nullptr,1,&resource);
  if(result.registered==ERROR_SUCCESS){
    std::array<RM_PROCESS_INFO,16> entries{};UINT needed=0,count=static_cast<UINT>(entries.size());DWORD reboot=0;
    result.listed=api.list(session,&needed,&count,entries.data(),&reboot);
    if(result.listed==ERROR_SUCCESS&&count<=entries.size()&&needed<=entries.size()){
      result.count=count;
      if(count==1){const auto& info=entries[0];
        result.pidMatches=info.Process.dwProcessId==pid;
        result.typeMatches=info.ApplicationType==RmService;
        result.nameMatches=wcsnlen_s(info.strServiceShortName,CCH_RM_MAX_SVC_NAME+1)<=CCH_RM_MAX_SVC_NAME
          &&_wcsicmp(info.strServiceShortName,FixtureService)==0;
        ULARGE_INTEGER created{};created.LowPart=info.Process.ProcessStartTime.dwLowDateTime;
        created.HighPart=info.Process.ProcessStartTime.dwHighDateTime;
        result.generationMatches=std::to_string(info.Process.dwProcessId)+":"+
          std::to_string(created.QuadPart+504911232000000000ULL)==reference;
      }
    }
  }
  result.ended=api.end(session);return result;
}
void writeFixtureResourceRecord(const FixtureResourceRecord& value) {
  write("{\"open\":");write(std::to_string(value.opened));write(",\"register\":");
  write(value.opened==ERROR_SUCCESS?std::to_string(value.registered):"null");
  write(",\"list\":");write(value.opened==ERROR_SUCCESS&&value.registered==ERROR_SUCCESS?std::to_string(value.listed):"null");
  write(",\"end\":");write(value.opened==ERROR_SUCCESS?std::to_string(value.ended):"null");
  write(",\"count\":");write(value.count?std::to_string(*value.count):"null");
  write(",\"pidMatches\":");write(value.pidMatches?"true":"false");
  write(",\"nameMatches\":");write(value.nameMatches?"true":"false");write(",\"typeMatches\":");write(value.typeMatches?"true":"false");
  write(",\"generationMatches\":");write(value.generationMatches?"true":"false");write("}");
}
void probeFixtureResources() {
  // SOURCE-ONLY diagnostic, never an alternative production admission. Compare
  // FILE versus fixed SERVICE metadata under the SAME ordinary token and exact
  // independently observed generation. A refusal is data, not a passing test,
  // control authority or permission to weaken the production FILE assertion.
  require(!administrator());auto manager=fixtureManager(SC_MANAGER_CONNECT);require(manager.value);
  ServiceHandle service(OpenServiceW(manager.value,FixtureService,SERVICE_QUERY_CONFIG|SERVICE_QUERY_STATUS));require(service.value);
  verifyCodexServiceConfiguration(service.value,fixtureRoot());const auto status=codexServiceStatus(service.value);
  require(status.dwCurrentState==SERVICE_RUNNING&&status.dwProcessId>0);
  const auto queried=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,status.dwProcessId);
  const DWORD queryError=queried?0:GetLastError();Handle queriedOwner(queried);
  const auto zero=OpenProcess(0,FALSE,status.dwProcessId);
  const DWORD zeroError=zero?0:GetLastError();Handle zeroOwner(zero);
  char reference[64]{};const auto length=GetEnvironmentVariableA("TRELIO_SERVICE_FIXTURE_REFERENCE",reference,64);
  require(length>0&&length<64);
  const auto file=probeFixtureResource(true,status.dwProcessId,std::string(reference,length));
  const auto named=probeFixtureResource(false,status.dwProcessId,std::string(reference,length));
  const auto basic=probeFixtureBasicProcess(status.dwProcessId);
  const auto second=probeFixtureBasicProcess(status.dwProcessId);
  const auto wmi=probeFixtureWmi(status.dwProcessId,std::string(reference,length));
  char sequence[32]{};const auto sequenceLength=GetEnvironmentVariableA("TRELIO_SERVICE_FIXTURE_SEQUENCE",sequence,32);
  const bool referenceMatches=sequenceLength>0&&sequenceLength<32&&basic.complete&&basic.found&&
    std::to_string(basic.sequence)==std::string(sequence,sequenceLength);
  require(codexServiceStatus(service.value).dwProcessId==status.dwProcessId);
  write("{\"diagnosticOnly\":true,\"notCIEvidence\":true,\"originalQuerySucceeded\":");write(queried?"true":"false");
  write(",\"originalQueryError\":");write(std::to_string(queryError));write(",\"zeroOpenSucceeded\":");write(zero?"true":"false");
  write(",\"zeroOpenError\":");write(std::to_string(zeroError));write(",\"file\":");writeFixtureResourceRecord(file);
  write(",\"service\":");writeFixtureResourceRecord(named);
  write(",\"basic\":{\"available\":");write(basic.available?"true":"false");write(",\"status\":");
  write(basic.available?std::to_string(basic.status):"null");write(",\"complete\":");write(basic.complete?"true":"false");
  write(",\"pidMatches\":");write(basic.found?"true":"false");write(",\"imageMatches\":");write(basic.imageMatches?"true":"false");
  write(",\"referenceMatches\":");write(referenceMatches?"true":"false");write(",\"stableMatches\":");
  write(basic.complete&&basic.found&&second.complete&&second.found&&second.imageMatches&&basic.sequence==second.sequence?"true":"false");
  write("},\"wmi\":{\"stage\":");write(std::to_string(wmi.stage));write(",\"status\":");write(std::to_string(wmi.status));
  write(",\"complete\":");write(wmi.complete?"true":"false");write(",\"pidMatches\":");write(wmi.pidMatches?"true":"false");
  write(",\"nameMatches\":");write(wmi.nameMatches?"true":"false");write(",\"pathAvailable\":");write(wmi.pathAvailable?"true":"false");
  write(",\"pathMatches\":");write(wmi.pathMatches?"true":"false");write(",\"creationAvailable\":");write(wmi.creationAvailable?"true":"false");
  write(",\"creationMatchesMicroseconds\":");write(wmi.creationMatchesMicroseconds?"true":"false");write("}}\n");
}
void cleanupFixture() {
  require(administrator());auto manager=fixtureManager(SC_MANAGER_CONNECT);require(manager.value);
  ServiceHandle service(OpenServiceW(manager.value,FixtureService,SERVICE_ALL_ACCESS));
  if(!service.value){require(GetLastError()==ERROR_SERVICE_DOES_NOT_EXIST);write("{\"cleaned\":true}\n");return;}
  verifyCodexServiceConfiguration(service.value,fixtureRoot());
  auto status=codexServiceStatus(service.value);
  if(status.dwCurrentState==SERVICE_RUNNING){
    // Cleanup of this exact newly-created inert fixture must remain possible
    // when the production observation UNDER TEST refused. It is not acceptance:
    // retain the original test failure and never use this branch in production.
    const DWORD originalPid=status.dwProcessId;require(originalPid>0);
    SERVICE_STATUS reply{};require(ControlService(service.value,SERVICE_CONTROL_STOP,&reply)!=FALSE);
    const auto started=GetTickCount64();
    while(true){status=codexServiceStatus(service.value);
      if(status.dwCurrentState==SERVICE_STOPPED&&status.dwProcessId==0&&!packageServicePidPresent(originalPid))break;
      require(GetTickCount64()-started<20000);Sleep(50);
    }
  }else require(status.dwCurrentState==SERVICE_STOPPED);
  require(DeleteService(service.value)!=FALSE);write("{\"cleaned\":true}\n");
}
void exerciseFixture(std::string_view operation,std::string_view expected) {
  fixtureStage="ordinary_identity";require(!administrator());
  fixtureStage="scm_manager";auto manager=fixtureManager(SC_MANAGER_CONNECT);require(manager.value);
  const DWORD access=SERVICE_QUERY_CONFIG|SERVICE_QUERY_STATUS|(operation=="stop"?SERVICE_STOP:operation=="start"?SERVICE_START:0);
  fixtureStage="scm_service";ServiceHandle service(OpenServiceW(manager.value,FixtureService,access));require(service.value);
  fixtureStage="scm_configuration";
  const auto root=fixtureRoot();verifyCodexServiceConfiguration(service.value,root);
  auto status=codexServiceStatus(service.value);
  if(operation=="start"){
    require(status.dwCurrentState==SERVICE_STOPPED&&status.dwProcessId==0);
    PackageServiceImage image(fixtureExecutable());require(image.read().empty());
    require(StartServiceW(service.value,0,nullptr)!=FALSE);waitFixtureState(service.value,SERVICE_RUNNING);
    status=codexServiceStatus(service.value);
  }
  fixtureStage="scm_running";require(status.dwCurrentState==SERVICE_RUNNING&&status.dwProcessId>0);
  fixtureStage="old_process_rights_must_refuse";
  Handle denied(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,status.dwProcessId));
  require(!denied.value&&GetLastError()==ERROR_ACCESS_DENIED);
  fixtureStage="bound_process";PackageServiceProcess process(status.dwProcessId,fixtureExecutable(),FixtureService);
  fixtureStage="scm_generation_recheck";
  verifyCodexServiceConfiguration(service.value,root);process.verify(codexServiceStatus(service.value).dwProcessId);
  if(operation=="refusals"){
    unsigned refused=0;
    try{PackageServiceProcess other(status.dwProcessId,fixtureExecutable(),L"ForeignService");}catch(...){++refused;}
    try{PackageServiceProcess other(status.dwProcessId,root+L"\\fixture-controller.exe",FixtureService);}catch(...){++refused;}
    try{process.verify(status.dwProcessId+1);}catch(...){++refused;}
    process.created.dwLowDateTime^=1;
    try{process.verify(status.dwProcessId);}catch(...){++refused;}
    require(refused==4);write("{\"refused\":4}\n");return;
  }
  if(operation=="stop"){
    require(expected==process.generation());
    verifyCodexServiceConfiguration(service.value,root);process.verify(codexServiceStatus(service.value).dwProcessId);
    SERVICE_STATUS reply{};require(ControlService(service.value,SERVICE_CONTROL_STOP,&reply)!=FALSE);
    process.waitForExit(service.value);codexServiceReply("stopped");return;
  }
  require(operation=="inspect"||operation=="start");codexServiceReply("running",process.generation());
}
}
int main(int argc,char* argv[]) {
  if(argc==1){SERVICE_TABLE_ENTRYW table[]={{const_cast<LPWSTR>(FixtureService),fixtureServiceMain},{nullptr,nullptr}};
    return StartServiceCtrlDispatcherW(table)?0:1;}
  try {
    require(argc==2||argc==3);const std::string_view command=argv[1];
    if(command=="prepare"&&argc==2){fixtureStage="prepare";prepareFixture();}
    else if(command=="cleanup"&&argc==2){fixtureStage="cleanup";cleanupFixture();}
    else if(command=="probe"&&argc==2){fixtureStage="resource_probe";probeFixtureResources();}
    else if((command=="inspect"||command=="start"||command=="refusals")&&argc==2){fixtureStage="ordinary_read";exerciseFixture(command,{});}
    else if(command=="stop"&&argc==3){fixtureStage="ordinary_stop";exerciseFixture(command,argv[2]);}
    else throw Failure{};
    return 0;
  }catch(const ServiceObservationFailure& error){
    write("{\"fixtureFailure\":true,\"stage\":\"");write(error.stage);write("\",\"detail\":");
    write(std::to_string(error.detail));write("}\n");return 1;
  }catch(...){write("{\"fixtureFailure\":true,\"stage\":\"");write(fixtureStage);write("\"}\n");return 1;}
}
