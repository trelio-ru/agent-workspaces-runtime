// SOURCE-TREE-ONLY fixture. This executable is never part of a signed package.
// Include the production primitives so a green test cannot merely demonstrate
// an independently implemented SCM/RM workaround. The public production main
// retains its fixed selectors; only this disposable fixture has test commands.
#define main trelioPrivateProcessMain
#include "../../host-runtime/scripts/native-private-process/PrivateProcess.cpp"
#undef main
#include <sddl.h>

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
  write("{\"prepared\":true}\n");
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
    else if((command=="inspect"||command=="start"||command=="refusals")&&argc==2){fixtureStage="ordinary_read";exerciseFixture(command,{});}
    else if(command=="stop"&&argc==3){fixtureStage="ordinary_stop";exerciseFixture(command,argv[2]);}
    else throw Failure{};
    return 0;
  }catch(const ServiceObservationFailure& error){
    write("{\"fixtureFailure\":true,\"stage\":\"");write(error.stage);write("\",\"detail\":");
    write(std::to_string(error.detail));write("}\n");return 1;
  }catch(...){write("{\"fixtureFailure\":true,\"stage\":\"");write(fixtureStage);write("\"}\n");return 1;}
}
